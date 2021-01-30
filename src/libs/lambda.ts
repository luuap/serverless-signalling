import middy from "@middy/core";
import type { ValidatedEventAPIGatewayProxyEvent } from '@libs/apiGateway';
import schema from '../schema';

export const middyfy = (handler: ValidatedEventAPIGatewayProxyEvent<typeof schema>) => {
  return middy(handler).use(jsonBodyParser);
}

const jsonBodyParser = {
  before: (handler: { event: any; }, next: () => void) => {
    const body = handler.event.body;
    if (body !== undefined && typeof body === 'string') {
      handler.event.body = JSON.parse(handler.event.body);
    }
    next();
  }
}