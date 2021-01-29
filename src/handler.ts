import 'source-map-support/register';

import { TextEncoder } from 'util';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import Redis from 'ioredis';

import type { ValidatedEventAPIGatewayProxyEvent } from '@libs/apiGateway';
import { formatJSONResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';

import schema from './schema';

const { REDIS_PORT, REDIS_HOST, REDIS_PASSWORD, AWS_REGION } = process.env;

// const connectionPool = new Map<string, Redis.Redis[]>(); // connection pool of producers for each connectionID

// const getFromConnectionPool = async (connectionId: string): Promise<Redis.Redis> => {
//   const connections = connectionPool.get(connectionId);
//   if (connections === undefined) {
//     connectionPool.set(connectionId, []);
//     const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

//     redis.options.retryStrategy = () => 20000; // extend the delay just in case default is too short, we want this so that no reconnection request is sent before we quit

//     // TODO: This might cause client to handle interruptions poorly because we are just straight up quitting
//     // TODO: does this cause the lambda to block or freeze, what happens when lambda freezes it
//     redis.on('close', () => {
//       console.log('Connection closed');
//       redis.quit();
//     });

//     const clientId = await redis.client('ID');
//     await redis.rpush(`clients:${connectionId}:producer`, clientId) // TODO expire
//     return redis;
//   } else if (connections.length > 0) {
//     return connections.pop(); // check if it's still alive
//   }
// }

const handler: ValidatedEventAPIGatewayProxyEvent<typeof schema> = async (event) => {

  console.log(event);

  let { routeKey, connectionId } = event.requestContext;
  
  let message: any;
  
  if (routeKey === 'addOffer') {
    
    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

    const { offer } = event.body;
    const clientId = await redis.client('ID');
    
    const roomId = event.requestContext.connectedAt.toString();

    await redis.multi()
      .rpush(`rooms:${roomId}:caller`, connectionId)
      .rpush(`clients:${connectionId}:consumer`, clientId) // holds the clientId
      .xadd(`queue:${connectionId}`, '*', 'data', JSON.stringify({ action: routeKey, offer })) // add the offer to queue
      .expire(`rooms:${roomId}:caller`, 120) // expire after 2 mins
      .expire(`clients:${connectionId}:consumer`, 120) // expire after 2 mins
      .expire(`queue:${connectionId}`, 120) // expire after 2 mins
      .exec();

    const { stage, domainName } = event.requestContext;
    sendCallbackMessage({ connectionId, stage, domainName }, JSON.stringify([{ action: 'sendRoomId', roomId }])); // should be in an array
    // console.log(JSON.stringify([{ action: 'sendRoomId', roomId }])); // uncomment for local testing

    const calleeConnectionId = (await redis.blpop(`rooms:${roomId}:callee`, 0))[1]; // TODO set to the timeout // this is null
    // TODO: what if connection was interrupted here

    // listen to callee queue
    // Note: key does not have to exist
    const callback = (message: string) => sendCallbackMessage({ connectionId: connectionId, stage, domainName }, message);
    // const callback = (message: string) => console.log('From callee: ' + message); // uncomment for local testing
    await readAllStreamBlocking(redis, `queue:${calleeConnectionId}`, '0', callback); // get all ids greater than 0
    
    await redis.quit();

    message = { actionDone: 'addOffer' };

  } else if (routeKey === 'joinRoom') { // TODO create test

    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

    const { roomId } = event.body;
    // console.log(`Room id = ${roomId}`);

    const clientId = await redis.client('ID');
    // TODO check if room exists

    await redis.multi()
      .rpush(`rooms:${roomId}:callee`, connectionId)
      .rpush(`clients:${connectionId}:consumer`, clientId)
      .expire(`rooms:${roomId}:callee`, 120) // expire after 2 mins
      .expire(`clients:${connectionId}:consumer`, 120) // expire after 2 mins
      .exec()
    
    // listen for caller queue
    const callerConnectionId = (await redis.blpop(`rooms:${roomId}:caller`, 0))[1];

    const { stage, domainName } = event.requestContext;
    const callback = (message: string) => sendCallbackMessage({ connectionId, stage, domainName }, message); // should send to this connectionId
    // const callback = (message: string) => console.log('From caller: ' + message); // uncomment for local testing
    await readAllStreamBlocking(redis, `queue:${callerConnectionId}`, '0', callback); // get all ids greater than 0
    await redis.quit();
    message = { actionDone: 'joinRoom' };

  } else if (routeKey === 'addAnswer') { // TODO create test

    const redis = new Redis({port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD});
    
    const { answer } = event.body;

    // push answer
    await redis.multi()
      .xadd(`queue:${connectionId}`, '*', 'data', JSON.stringify({ action: routeKey, answer })) // need to stringify or else it will go in as [Object object]
      .expire(`queue:${connectionId}`, 120) // expire after 2 mins
      .exec();

    await redis.quit();
    message = { actionDone: 'addAnswer' };

  } else if (routeKey === 'addIceCandidate') {

    const { candidate } = event.body;

    // const redis = await getFromConnectionPool(connectionId);
    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });

    // add to caller/callee (based on connectionId) queue
    await redis.xadd(`queue:${connectionId}`, '*', 'data', JSON.stringify({ action: routeKey, candidate })); // candidate has already been parsed, whole body was stringified

    await redis.quit();
    // return the client to the connection pool
    // connectionPool.get(connectionId).push(redis);

    message = { actionDone: 'addIceCandidate' };

  } else if (routeKey === '$disconnect') {
    const redis = new Redis({ port: +REDIS_PORT, host: REDIS_HOST, password: REDIS_PASSWORD });
    
    // unblock the consumers
    const consumerClientId = await redis.lpop(`clients:${connectionId}:consumer`); // there is only one consumer
    let unblocked = 0; // holds the return status of operation
    let retries = 0;
    while (unblocked === 0 && retries <= 20) {
      unblocked = await redis.client('UNBLOCK', consumerClientId);
      retries += 1;
    }

    // // kill the producers
    // const producerClientIds = await redis.lrange(`clients:${connectionId}:producer`, 0, -1); // TODO remove the key
    // const promises = producerClientIds.map(async (id) => {
    //   let killed = 0;
    //   let retries = 0;
    //   while (killed === 0 && retries <= 20) {
    //     try {
    //       killed = await redis.client('KILL', 'ID', id);
    //       retries += 1;
    //     } catch { // if there is an error, connection is already closed
    //       killed - 1;
    //     }
    //   }
    // });

    // await Promise.all(promises);

    redis.disconnect();
  }

  return formatJSONResponse({
    ...message,
  });
}

// Docs: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-apigatewaymanagementapi/index.html
const sendCallbackMessage = async (context: { connectionId: string, stage: string, domainName: string }, message: string) => {

  let { connectionId, stage, domainName } = context;

  // TODO make this global
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
  await apiGatewayManagementApi.send(command); // gone exception
}

// read from stream
const readAllStreamBlocking = async (redis: Redis.Redis, streamKey: string, entryId: string, cb: (...args: any[]) => any) => {
  const stream = await redis.xread('BLOCK', 0, 'STREAMS', streamKey, entryId);

  if (stream !== null) { // null happens when redis client connection is stopped
    const all = stream[0][1]; // array of [id, [field, value]] 
    const latestEntryId = all[all.length - 1][0];
    const messages = all.map((streamData) => {
      return JSON.parse(streamData[1][1]);
    });

    await cb(JSON.stringify(messages)); // TODO make sure the messages are not already stringified
    await readAllStreamBlocking(redis, streamKey, latestEntryId, cb);
  }
}

export const main = middyfy(handler);
