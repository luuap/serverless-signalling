import middy from "@middy/core";

export const middyfy = (handler) => {
  return middy(handler).use(jsonBodyParser);
}

const jsonBodyParser = {
  before: (handler, next) => {
    const body = handler.event.body;
    if (body !== undefined && typeof body === 'string') {
      handler.event.body = JSON.parse(handler.event.body);
    }
    next();
  }
}