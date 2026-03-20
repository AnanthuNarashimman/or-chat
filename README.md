# OR Chat

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Pinecone](https://img.shields.io/badge/Pinecone-Vector%20DB-0bb97f)](https://www.pinecone.io/)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-LLM%20Gateway-ff4b4b)](https://openrouter.ai/)

Local chat app using OpenRouter for LLMs and Pinecone for semantic memory. I built this mainly to try out OpenRouter and don’t have further development plans beyond this.

## Models
- NVIDIA: `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3-nano-30b-a3b:free`, `nvidia/nemotron-nano-9b-v2:free`, `nvidia/nemotron-nano-12b-v2-vl:free`
- Arcee AI: `arcee-ai/trinity-large-preview:free`, `arcee-ai/trinity-mini:free`
- StepFun: `stepfun/step-3.5-flash:free`

## Requirements
- Node.js 18+
- Pinecone account + index (e.g. `orchat-memory`)
- OpenRouter account + API key

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the project root:
   ```bash
   OPENROUTER_API_KEY=your-openrouter-api-key
   PINECONE_API_KEY=your-pinecone-api-key
   PINECONE_INDEX=orchat-memory
   ```

3. Start the dev server:
   ```bash
   npm run dev
   ```

4. Open `http://localhost:3000` in your browser.
