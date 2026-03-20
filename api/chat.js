// api/chat.js
// Streams chat completions via OpenRouter and saves messages to Pinecone memory

import { Pinecone } from '@pinecone-database/pinecone';

export const config = { runtime: 'nodejs' };

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const EMBED_MODEL = 'openai/text-embedding-3-small';
const MEMORY_TOP_K = 5;
const PINECONE_INDEX = process.env.PINECONE_INDEX || 'orchat-memory';

// ---------- helpers ----------

async function embed(text, orKey) {
  const res = await fetch(`${OPENROUTER_API}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${orKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embed failed: ${err}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

async function queryMemory(pc, namespace, vector, topK) {
  try {
    const index = pc.index(PINECONE_INDEX).namespace(namespace);
    const results = await index.query({ vector, topK, includeMetadata: true });
    return results.matches || [];
  } catch {
    return [];
  }
}

async function upsertMemory(pc, namespace, id, vector, metadata) {
  try {
    const index = pc.index(PINECONE_INDEX).namespace(namespace);
    await index.upsert([{ id, values: vector, metadata }]);
  } catch (e) {
    console.error('Upsert failed:', e.message);
  }
}

// ---------- handler ----------

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-or-key',
      },
    });
  }

  try {
    const body = await req.json();
    const { messages, model, chatId, userId = 'default' } = body;

    const orKey = req.headers.get('x-or-key') || process.env.OPENROUTER_API_KEY;
    const pineconeKey = process.env.PINECONE_API_KEY;

    if (!orKey) return errorResponse('Missing OpenRouter API key', 401);
    if (!pineconeKey) return errorResponse('Missing PINECONE_API_KEY env var', 500);
    if (!messages?.length) return errorResponse('No messages provided', 400);

    const namespace = `${userId}`;
    const pc = new Pinecone({ apiKey: pineconeKey });

    // Last user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUserMsg?.content || '';

    // 1. Embed the user query and retrieve relevant memories
    let memoryContext = '';
    try {
      const queryVec = await embed(userText, orKey);
      const matches = await queryMemory(pc, namespace, queryVec, MEMORY_TOP_K);

      if (matches.length > 0) {
        const memLines = matches
          .filter(m => m.score > 0.75)
          .map(m => `[${m.metadata.role}] ${m.metadata.content}`)
          .join('\n');
        if (memLines) {
          memoryContext = `Relevant context from previous conversations:\n${memLines}`;
        }
      }
    } catch (e) {
      console.error('Memory retrieval failed:', e.message);
    }

    // 2. Build messages with memory injected as system prompt
    const systemPrompt = [
      'You are a helpful assistant.',
      memoryContext ? `\n${memoryContext}` : '',
    ].filter(Boolean).join('\n');

    const augmentedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // 3. Stream from OpenRouter
    const orRes = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${orKey}`,
        'HTTP-Referer': 'https://orchat.vercel.app',
        'X-Title': 'OR Chat',
      },
      body: JSON.stringify({
        model,
        messages: augmentedMessages,
        stream: true,
      }),
    });

    if (!orRes.ok) {
      const err = await orRes.text();
      return errorResponse(`OpenRouter error: ${err}`, orRes.status);
    }

    // 4. Pass the stream through to the client, collect full response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let assistantContent = '';

    (async () => {
      const reader = orRes.body.getReader();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            await writer.write(encoder.encode(line + '\n'));
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const chunk = JSON.parse(line.slice(6));
                const delta = chunk.choices?.[0]?.delta?.content || '';
                assistantContent += delta;
              } catch {}
            }
          }
        }

        // Write remaining buffer
        if (buffer) await writer.write(encoder.encode(buffer + '\n'));

      } finally {
        await writer.close();

        // 5. After stream ends, save both messages to Pinecone (background)
        if (userText && assistantContent && chatId) {
          const ts = Date.now();
          try {
            const [userVec, assistantVec] = await Promise.all([
              embed(userText, orKey),
              embed(assistantContent, orKey),
            ]);
            await Promise.all([
              upsertMemory(pc, namespace, `${chatId}-u-${ts}`, userVec, {
                role: 'user',
                content: userText,
                chatId,
                ts,
              }),
              upsertMemory(pc, namespace, `${chatId}-a-${ts}`, assistantVec, {
                role: 'assistant',
                content: assistantContent.slice(0, 1000), // cap metadata size
                chatId,
                ts,
              }),
            ]);
          } catch (e) {
            console.error('Post-stream memory save failed:', e.message);
          }
        }
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    return errorResponse(err.message, 500);
  }
}

function errorResponse(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
