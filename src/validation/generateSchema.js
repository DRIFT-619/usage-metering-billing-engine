'use strict';

const { z } = require('zod');

const tokenCounts = z
  .object({
    input: z.number().int().min(0).default(0),
    cached_input: z.number().int().min(0).default(0),
    output: z.number().int().min(0).default(0),
    reasoning: z.number().int().min(0).default(0),
  })
  .refine((t) => t.input + t.cached_input + t.output + t.reasoning > 0, {
    message: 'tokens must include at least one non-zero category',
  });

// A discriminated union: the shape of the body depends entirely on `type`.
const generateRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api_call') }).strict(),
  z.object({ type: z.literal('ai_tokens'), tokens: tokenCounts }).strict(),
]);

module.exports = { generateRequestSchema };