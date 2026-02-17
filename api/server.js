import express from "express";
import pkg from "pg";
import dotenv from "dotenv";
import { HfInference } from "@huggingface/inference";
import { createAgent } from "../agents/agent_logic.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const { Pool } = pkg;
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT),
});

const hf = new HfInference(process.env.HF_API_KEY);
const PORT = process.env.PORT || 3000;

let agentExecutor = null;

// Initialize LangChain Agent
async function initAgent() {
    try {
        const agentData = await createAgent();
        agentExecutor = agentData.agentExecutor;
        console.log("🤖 Agent initialized and connected to MCP");
    } catch (err) {
        console.error("❌ Failed to initialize agent:", err);
    }
}

/**
 * REST ENDPOINTS
 */

// POST /items - Bulk or single ingestion
app.post("/items", async (req, res) => {
    try {
        const body = req.body;
        if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
            return res.status(400).json({ error: "Missing request body" });
        }

        const items = Array.isArray(body) ? body : [body];
        const names = items.map(item => {
            if (typeof item === "string") return item.trim();
            if (item && typeof item === "object") {
                return (item.name || item.itemName || "").toString().trim();
            }
            return "";
        }).filter(n => n.length > 0);

        if (names.length === 0) return res.status(400).json({ error: "Name is required" });
        if (names.length !== items.length) return res.status(400).json({ error: "One or more items missing valid name" });

        const embeddingResponse = await hf.featureExtraction({
            model: "sentence-transformers/all-MiniLM-L6-v2",
            inputs: names,
        });

        const embeddings = Array.isArray(embeddingResponse[0]) ? embeddingResponse : [embeddingResponse];
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const insertedItems = [];
            for (let i = 0; i < names.length; i++) {
                const vectorString = `[${embeddings[i].join(",")}]`;
                const result = await client.query(
                    "INSERT INTO items (name, embedding) VALUES ($1, $2) RETURNING id, name",
                    [names[i], vectorString]
                );
                insertedItems.push(result.rows[0]);
            }
            await client.query("COMMIT");
            res.status(201).json({ message: `${insertedItems.length} items created`, items: insertedItems });
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /items - List items
app.get("/items", async (req, res) => {
    try {
        const limit = Number(req.query.limit) || 50;
        const result = await pool.query("SELECT id, name FROM items ORDER BY id DESC LIMIT $1", [limit]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /search - Raw vector search
app.get("/search", async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: "Query required" });
        const embeddingResponse = await hf.featureExtraction({ model: "sentence-transformers/all-MiniLM-L6-v2", inputs: query });
        const queryEmbedding = Array.isArray(embeddingResponse[0]) ? embeddingResponse[0] : embeddingResponse;
        const result = await pool.query("SELECT id, name FROM items ORDER BY embedding <-> $1 LIMIT 5", [`[${queryEmbedding.join(",")}]`]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * AGENT ENDPOINTS
 */

// POST /ask - AI Search
app.post("/ask", async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Query required" });
        if (!agentExecutor) await initAgent();
        const result = await agentExecutor.invoke({ input: query });
        res.json({ query, answer: result.output });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /chat - General agent commands
app.post("/chat", async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Message required" });
        if (!agentExecutor) await initAgent();
        const result = await agentExecutor.invoke({ input: message });
        res.json({ response: result.output });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, async () => {
    console.log(`🚀 Server: http://localhost:${PORT}`);
    await initAgent();
});
