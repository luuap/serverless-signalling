import 'source-map-support/register';

import { TextEncoder } from 'util';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import Redis from 'ioredis';

import type { ValidatedEventAPIGatewayProxyEvent } from '@libs/apiGateway';
import { formatJSONResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';

import schema from './schema';

const { REDIS_PORT, REDIS_HOST, REDIS_PASSWORD, AWS_REGION } = process.env;
const EXPIRE_TIME = 120; // seconds before redis key will expire

// TODO: investigate the behavior of redis client when lambda is frozen to implement connection caching in between invocations

const handler: ValidatedEventAPIGatewayProxyEvent<typeof schema> = async (event) => {

  console.log(event);

  let { connectionId, routeKey: action } = event.requestContext;
  
  let message: any;
  
  if (action === 'addOffer') {
    
    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

    const { offer } = event.body;

    const roomId = event.requestContext.connectedAt.toString(); // TODO change this to uuid 

    await redis.multi()
      .rpush(`rooms:${roomId}:caller`, connectionId)
      .xadd(`queue:${connectionId}`, '*', 'data', JSON.stringify({ action, offer })) // add the offer to queue
      .expire(`rooms:${roomId}:caller`, 120) // expire after 2 mins
      .expire(`queue:${connectionId}`, 120)
      .exec();

    const { stage, domainName } = event.requestContext;
    await sendCallbackMessage({ connectionId, stage, domainName }, JSON.stringify([{ action: 'sendRoomId', roomId }])); // should be in an array, TODO fix this

    await redis.quit();

    message = { actionDone: 'addOffer' };

  } else if (action === 'joinRoom') {

    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

    const { roomId } = event.body;

    const clientId = await redis.client('ID');
    // TODO check if room exists

    await redis.multi()
      .rpush(`rooms:${roomId}:callee`, connectionId)
      .rpush(`clients:${connectionId}:consumer`, clientId)  // save the client id because we will have a blocking call
      .expire(`rooms:${roomId}:callee`, EXPIRE_TIME)
      .expire(`clients:${connectionId}:consumer`, EXPIRE_TIME)
      .exec()
    
    // get caller connection id
    const callerConnectionId = (await redis.blpop(`rooms:${roomId}:caller`, 0))[1];

    const { stage, domainName } = event.requestContext;

    // inform caller that there is someone joining the call
    await sendCallbackMessage({ connectionId: callerConnectionId, stage, domainName }, JSON.stringify([{action: 'informAvailableAnswer'}])); // TODO must be wrapped in array, fix this

    // callback when we get values from the stream
    const callback = (message: string) => sendCallbackMessage({ connectionId, stage, domainName }, message);
    // listen to callee queue
    // Note: key does not have to exist to be able to listen for values
    await readStreamBlocking(redis, `queue:${callerConnectionId}`, '0', callback); // get all ids greater than 0
    await redis.quit();
    message = { actionDone: 'joinRoom' };

  } else if (action === 'addAnswer') {

    const redis = new Redis({port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD});
    
    const { answer } = event.body;

    // push answer
    await redis.multi()
      .xadd(`queue:${connectionId}`, '*', 'data', JSON.stringify({ action, answer })) // need to stringify or else it will go in as [Object object]
      .expire(`queue:${connectionId}`, EXPIRE_TIME) // expire after 2 mins
      .exec();

    await redis.quit();
    message = { actionDone: 'addAnswer' };

  } else if (action === 'receiveAnswer') {

    const { roomId } = event.body;
    const { stage, domainName } = event.requestContext;

    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

    const clientId = await redis.client('ID');
    await redis.multi()
      .rpush(`clients:${connectionId}:consumer`, clientId)
      .expire(`clients:${connectionId}:consumer`, EXPIRE_TIME)
      .exec();

    // TODO only recieve the call in the room you're in
    const calleeConnectionId = (await redis.blpop(`rooms:${roomId}:callee`, 0))[1];

    const callback = (message: string) => sendCallbackMessage({ connectionId, stage, domainName }, message);

    await readStreamBlocking(redis, `queue:${calleeConnectionId}`, '0', callback); // get all ids greater than 0

    await redis.quit();

    message = { actionDone: 'receiveAnswer' };

  } else if (action === 'addIceCandidate') {

    const { candidate } = event.body;

    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

    // add to caller/callee queue, we know whether we are caller or caller based on our connectionId
    await redis.xadd(`queue:${connectionId}`, '*', 'data', JSON.stringify({ action, candidate })); // candidate has already been parsed in middleware, so it's not double stringified

    await redis.quit();

    message = { actionDone: 'addIceCandidate' };

  } else if (action === '$disconnect') {
    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });
    
    // unblock the consumers
    const consumerClientId = await redis.lpop(`clients:${connectionId}:consumer`); // there is only one consumer per connectionId
    let unblocked = 0; // holds the return status of operation
    let retries = 0;
    while (unblocked === 0 && retries <= 20) { // unblocking can fail sometimes
      unblocked = await redis.client('UNBLOCK', consumerClientId);
      retries += 1;
    }

    redis.disconnect();
  } else {
    message = { actionDone: 'Invalid Action'} // TODO send a 403
  }

  return formatJSONResponse({
    ...message,
  });
}

// Docs: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-apigatewaymanagementapi/index.html
const sendCallbackMessage = async (context: { connectionId: string, stage: string, domainName: string }, message: string) => {

  let { connectionId, stage, domainName } = context;

  // TODO implement connection pooling
  let apiGatewayManagementApi = new ApiGatewayManagementApiClient({
    apiVersion: '2018-11-29',
    endpoint: `https://${domainName}/${stage}`,
    region: AWS_REGION,
  });

  const params = {
    ConnectionId: connectionId,
    Data: new TextEncoder().encode(message),
  };

  const command = new PostToConnectionCommand(params)

  // TODO: workaround for https://github.com/aws/aws-sdk-js-v3/issues/1830
  apiGatewayManagementApi.middlewareStack.add(
    (next) =>
      async (args) => {
        args.request['path'] = stage + args.request['path'];
        return await next(args);
      },
    { step: "build" },
  );

  // Make sure the lambda has permission Allow: execute-api:ManageConnections on arn:aws:execute-api{region}:{account-id}:{api-id}:{stage}/POST/@connections/*
  await apiGatewayManagementApi.send(command)
    .catch(error => {
      // might get GoneException when ice negotiation finishes without using up all candidates, thus client closes connection before we can send this last message
      console.log(`Error sending message: ${message}`, error);
    })
    .finally(() => {
      apiGatewayManagementApi.destroy();
    });
}

// reads batches of data in a stream
// this is recursive and halts when client is unblocked
const readStreamBlocking = async (redis: Redis.Redis, streamKey: string, entryId: string, cb: (...args: any[]) => any) => {

  // read the old entries
  const batch = await redis.xread('BLOCK', 0, 'STREAMS', streamKey, entryId);

  if (batch !== null) { // null happens when redis client connection is stopped
    const all = batch[0][1]; // array of [id, [field, value]] 
    const latestEntryId = all[all.length - 1][0];
    const messages = all.map((streamData) => {
      return JSON.parse(streamData[1][1]);
    });

    await cb(JSON.stringify(messages));
    await readStreamBlocking(redis, streamKey, latestEntryId, cb);
  }
}

export const main = middyfy(handler);
