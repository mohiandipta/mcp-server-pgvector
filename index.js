import express from "express";
import bodyParser from "body-parser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import pkg from "pg"
import dotenv from "dotenv"

dotenv.config()
const { Pool } = pkg

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
})

async function startServer() {
    try {
        await pool.query("SELECT 1")
        console.log("✅ DB successfully connected")

        const server = new McpServer({
            name: "pgvector-mcp",
            version: "1.0.0",
        })

        // Register Pool
        server.tool(
            "search_items",
            {
                query_embedding: {
                    types: "array",
                    items: { type: "number" },
                    minItem: 384,
                    maxItem: 384,
                },
            },
            async ({ query_embedding }) => {
                const result = await pool.query(
                    `SELECT id, name 
                     FROM items
                     ORDER BY embedding <-> $1
                     LIMIT 5`,
                    [query_embedding]
                )
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                result.rows.map(row => ({
                                    id: row.id,
                                    name: row.name,
                                }))
                            ),
                        },
                    ],
                }
            }
        )

        const transport = new StdioServerTransport()
        await server.connect(transport)
    } catch (err) {
        console.error("❌ Database error:", err)
    }
}

startServer()
