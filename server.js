// Local development server
import express from 'express';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
  } catch (e) {
    console.error('Memory query failed:', e.message);
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

// ---------- Chat endpoint ----------

app.post('/api/chat', async (req, res) => {
  try {
    console.log('📨 Chat request received');
    const { messages, model, chatId, userId = 'default' } = req.body;

    const orKey = req.headers['x-or-key'] || process.env.OPENROUTER_API_KEY;
    const pineconeKey = process.env.PINECONE_API_KEY;

    if (!orKey) {
      console.error('❌ Missing OpenRouter API key');
      return res.status(401).json({ error: 'Missing OpenRouter API key' });
    }
    if (!pineconeKey) {
      console.error('❌ Missing PINECONE_API_KEY');
      return res.status(500).json({ error: 'Missing PINECONE_API_KEY env var' });
    }
    if (!messages?.length) {
      console.error('❌ No messages provided');
      return res.status(400).json({ error: 'No messages provided' });
    }

    const namespace = `${userId}`;
    const pc = new Pinecone({ apiKey: pineconeKey });

    // Last user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUserMsg?.content || '';
    console.log('💬 User message:', userText.slice(0, 50));

    // 1. Retrieve relevant memories
    let memoryContext = '';
    try {
      console.log('🔍 Searching memory...');
      const queryVec = await embed(userText, orKey);
      const matches = await queryMemory(pc, namespace, queryVec, MEMORY_TOP_K);

      if (matches.length > 0) {
        const memLines = matches
          .filter(m => m.score > 0.75)
          .map(m => `[${m.metadata.role}] ${m.metadata.content}`)
          .join('\n');
        if (memLines) {
          memoryContext = `Relevant context from previous conversations:\n${memLines}`;
          console.log(`✅ Found ${matches.filter(m => m.score > 0.75).length} relevant memories`);
        }
      } else {
        console.log('ℹ️  No memories found');
      }
    } catch (e) {
      console.error('⚠️  Memory retrieval failed:', e.message);
    }

    // 2. Build messages with memory
    const systemPrompt = [
      'You are a helpful assistant. Be clear and concise in your responses - avoid unnecessary verbosity while maintaining completeness.',
      memoryContext ? `\n${memoryContext}` : '',
    ].filter(Boolean).join('\n');

    const augmentedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // 3. Stream from OpenRouter
    console.log('🚀 Calling OpenRouter...');
    const orRes = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${orKey}`,
        'HTTP-Referer': 'https://orchat.local',
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
      console.error('❌ OpenRouter error:', err);
      return res.status(orRes.status).json({ error: `OpenRouter error: ${err}` });
    }

    // 4. Stream to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let assistantContent = '';
    const reader = orRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          res.write(line + '\n');
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const chunk = JSON.parse(line.slice(6));
              const delta = chunk.choices?.[0]?.delta?.content || '';
              assistantContent += delta;
            } catch {}
          }
        }
      }

      if (buffer) res.write(buffer + '\n');
      res.end();

      // 5. Save to memory in background (don't block response)
      if (userText && assistantContent && chatId) {
        console.log('💾 Saving to memory...');
        const ts = Date.now();
        setImmediate(async () => {
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
                content: assistantContent.slice(0, 1000),
                chatId,
                ts,
              }),
            ]);
            console.log('✅ Memory saved');
          } catch (e) {
            console.error('⚠️  Memory save failed:', e.message);
          }
        });
      }
    } catch (err) {
      console.error('❌ Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }

  } catch (err) {
    console.error('❌ Chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ---------- Memory endpoint ----------

app.post('/api/memory', async (req, res) => {
  try {
    console.log('🔍 Memory search request');
    const { query, userId = 'default', topK = 10 } = req.body;
    const orKey = req.headers['x-or-key'] || process.env.OPENROUTER_API_KEY;
    const pineconeKey = process.env.PINECONE_API_KEY;

    const pc = new Pinecone({ apiKey: pineconeKey });
    const vec = await embed(query, orKey);
    const index = pc.index(PINECONE_INDEX).namespace(userId);
    const results = await index.query({ vector: vec, topK, includeMetadata: true });

    console.log(`✅ Found ${results.matches?.length || 0} memories`);
    res.json({ matches: results.matches });
  } catch (e) {
    console.error('❌ Memory search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/memory', async (req, res) => {
  try {
    console.log('🗑️  Clear memory request');
    const { userId = 'default' } = req.body;
    const pineconeKey = process.env.PINECONE_API_KEY;
    const pc = new Pinecone({ apiKey: pineconeKey });

    const index = pc.index(PINECONE_INDEX).namespace(userId);
    await index.deleteAll();

    console.log('✅ Memory cleared');
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Clear memory error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.options('/api/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-or-key');
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 OR Chat server running at http://localhost:${PORT}\n`);
  console.log('📁 Environment:');
  console.log(`   OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`   PINECONE_API_KEY: ${process.env.PINECONE_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`   PINECONE_INDEX: ${process.env.PINECONE_INDEX || 'orchat-memory'}\n`);
});
