import Redis from 'ioredis';

const { REDIS_PORT, REDIS_HOST } = process.env;

const roomId = '0';
const callerConnectionID = '0';
const calleeConnectionID = '1';

// emulate callee adding a connection id, then an offer or a candidate, then caller closing connection
const testAddOffer = async (redis: Redis.Redis) => {

  await redis.multi()
    .rpush(`rooms:${roomId}:callee`, 1)
    .xadd(`queue:${calleeConnectionID}`, '*', 'data', JSON.stringify({ ice: 'offer' }))
    .xadd(`queue:${calleeConnectionID}`, '*', 'data', JSON.stringify({ ice: 'callee candidate' }))
    .exec()
  
  await disconnect(redis, callerConnectionID);
}

// emulate caller and callee simultaneously adding ice candidates
// call when both are caller and callee are running
const testAddIceCandidates = async (redis: Redis.Redis) => {
  await redis.xadd(`queue:${calleeConnectionID}`, '*', 'data', "{\"candidate\":{\"candidate\":\"callee\",\"sdpMLineIndex\":\"sdp\",\"sdpMid\":\"sdp\"}}");
  await redis.xadd(`queue:${callerConnectionID}`, '*', 'data', "{\"candidate\":{\"candidate\":\"caller\",\"sdpMLineIndex\":\"sdp\",\"sdpMid\":\"sdp\"}}");
  await redis.xadd(`queue:${calleeConnectionID}`, '*', 'data', "{\"candidate\":{\"candidate\":\"callee\",\"sdpMLineIndex\":\"sdp\",\"sdpMid\":\"sdp\"}}");
  await redis.xadd(`queue:${callerConnectionID}`, '*', 'data', "{\"candidate\":{\"candidate\":\"caller\",\"sdpMLineIndex\":\"sdp\",\"sdpMid\":\"sdp\"}}");
  await redis.xadd(`queue:${calleeConnectionID}`, '*', 'data', "{\"candidate\":{\"candidate\":\"callee\",\"sdpMLineIndex\":\"sdp\",\"sdpMid\":\"sdp\"}}");
  await redis.xadd(`queue:${callerConnectionID}`, '*', 'data', "{\"candidate\":{\"candidate\":\"caller\",\"sdpMLineIndex\":\"sdp\",\"sdpMid\":\"sdp\"}}");
}

const disconnect = async (redis: Redis.Redis, connectionId: string) => {
  const clientId: string = JSON.parse(await redis.lpop(`meta:${connectionId}`)).clientId;
  let unblocked = 0;
  let retries = 0;
  while (unblocked === 0 && retries <= 20) {
    unblocked = await redis.client('UNBLOCK', clientId);
    retries += 1;
  }
  console.log('Unblock retries = ', retries);
}

const readAllStreamBlocking = async (redis: Redis.Redis, streamKey: string, entryId: string) => { // maybe a callback
  const all = (await redis.xread('BLOCK', 0, 'STREAMS', streamKey, entryId))[0][1]; // array of [id, [field, value]]
  const latestEntryId = all[all.length - 1][0];
  const messages = all.map((streamData) => {
    return streamData[1][1];
  })
  console.log(latestEntryId, messages);

  await readAllStreamBlocking(redis, streamKey, latestEntryId);
}


const main = async () => {

  const redis = new Redis(+REDIS_PORT, REDIS_HOST);

  // await testAddOffer(redis);
  await testAddIceCandidates(redis);
  // const clientId = await redis.client('ID');
  // console.log(clientId);
  // await readAllStreamBlocking(redis, `rooms:${connectedAt}:callee_queue`, '0');
  redis.quit();
}

main();