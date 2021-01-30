# serverless-signalling

A WebRTC signalling service for a simple messaging app using AWS Lambda and Redis. 

## Requirements
- a Redis instance that can be accessed from the internet

## Installation
1. `npm i`

## Deployment
1. Run `serverless package`
2. Create a Lambda with Node.js 12.x runtime
3. Upload the `.zip` file in `./serverless`
4. Set the handler to `src/handler.main`
5. Set the `REDIS_PORT`, `REDIS_HOST`, and `REDIS_PASSWORD` environment variables
6. Deploy the funtion

## Setting up API Gateway
1. Create a WebSocket API with the following routes: `$disconnect`, `addAnswer`, `addIceCandidate`, `addOffer`, `joinRoom`, `receiveAnswer` and route selection expression set to `$request.body.action`
2. Add lambda proxy integration to all the routes, add integration response as well
3. Go back to lambda and add `Allow: execute-api:ManageConnections` on `arn:aws:execute-api{region}:{account-id}{api-id}:{stage}/POST/@connections/*`
4. Deploy API

## Usage
See [@luuap/rtc-demo](https://github.com/luuap/rtc-demo)

---

This project has been generated using the `aws-nodejs-typescript` template from the [Serverless framework](https://www.serverless.com/).