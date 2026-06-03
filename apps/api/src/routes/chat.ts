import type { FastifyInstance } from 'fastify';
import { ChatPostRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { listChat, postChat } from '../services/chat.ts';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chat', async () => ({ messages: await listChat(await getDb()) })); // public read

  app.post('/chat', { preHandler: authenticate }, async (req) => {
    const { body } = ChatPostRequest.parse(req.body ?? {});
    return postChat(await getDb(), req.userId!, body);
  });
}
