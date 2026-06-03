import type { FastifyInstance } from 'fastify';
import { ChatPostRequest, UsernameRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { listChat, postChat, getProfile, setUsername } from '../services/chat.ts';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chat', async () => ({ messages: await listChat(await getDb()) })); // public read

  app.post('/chat', { preHandler: authenticate }, async (req) => {
    const { body, replyTo } = ChatPostRequest.parse(req.body ?? {});
    return postChat(await getDb(), req.userId!, body, replyTo);
  });

  app.get('/me/profile', { preHandler: authenticate }, async (req) => {
    return getProfile(await getDb(), req.userId!);
  });

  app.post('/me/username', { preHandler: authenticate }, async (req) => {
    const { username } = UsernameRequest.parse(req.body ?? {});
    return setUsername(await getDb(), req.userId!, username);
  });
}
