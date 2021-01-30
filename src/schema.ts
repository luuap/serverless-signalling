export default {
  type: 'object',
  properties: {
    offer: { type: 'string' },
    answer: { type: 'string' },
    candidate: { type: 'string' },
    roomId: { type: 'string' },
    message: { type: 'string' },
    action: {type: 'string'},
  },
} as const;
