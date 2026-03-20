// api/memory.js
// Query or delete memory entries from Pinecone

import { Pinecone } from '@pinecone-database/pinecone';

export const config = { runtime: 'nodejs' };

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const EMBED_MODEL = 'openai/text-embedding-3-small';
const PINECONE_INDEX = process.env.PINECONE_INDEX || 'orchat-memory';

async function embed(text, orKey) {
  const res = await fetch(`${OPENROUTER_API}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${orKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-or-key',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const pineconeKey = process.env.PINECONE_API_KEY;
  const orKey = req.headers.get('x-or-key') || process.env.OPENROUTER_API_KEY;
  const pc = new Pinecone({ apiKey: pineconeKey });

  // DELETE — clear all memory for a user
  if (req.method === 'DELETE') {
    try {
      const { userId = 'default' } = await req.json();
      const index = pc.index(PINECONE_INDEX).namespace(userId);
      await index.deleteAll();
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }

  // POST — search memory
  if (req.method === 'POST') {
    try {
      const { query, userId = 'default', topK = 10 } = await req.json();
      const vec = await embed(query, orKey);
      const index = pc.index(PINECONE_INDEX).namespace(userId);
      const results = await index.query({ vector: vec, topK, includeMetadata: true });
      return new Response(JSON.stringify({ matches: results.matches }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}
