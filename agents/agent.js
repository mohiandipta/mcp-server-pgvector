import dotenv from "dotenv";
import { ChatGroq } from "@langchain/groq";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DynamicStructuredTool } from "langchain/tools";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { z } from "zod";

dotenv.config();

async function main() {

    // 1️⃣ Create MCP client (with required capabilities)
    const client = new Client(
        {
            name: "langchain-agent",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // 2️⃣ Create transport
    const transport = new StdioClientTransport({
        command: "node",
        args: ["mcp-server/index.js"],
    });

    // 3️⃣ Connect properly
    await client.connect(transport);

    console.log("✅ Connected to MCP server");

    // 4️⃣ Load MCP tools
    const toolsResponse = await client.listTools();
    const mcpTools = toolsResponse.tools || [];
    console.log("✅ Tools:", mcpTools.map(t => t.name));

    // 5️⃣ Wrap MCP tools for LangChain
    const tools = mcpTools.map((tool) => {
        // Convert JSON schema to Zod schema
        let zodSchema;
        if (tool.inputSchema && typeof tool.inputSchema === 'object') {
            // Create a dynamic Zod schema based on the input schema
            const properties = tool.inputSchema.properties || {};
            const required = tool.inputSchema.required || [];

            const schemaObj = {};
            for (const [key, value] of Object.entries(properties)) {
                if (value.type === 'string') {
                    schemaObj[key] = required.includes(key) ? z.string() : z.string().optional();
                } else if (value.type === 'number') {
                    schemaObj[key] = required.includes(key) ? z.number() : z.number().optional();
                } else if (value.type === 'boolean') {
                    schemaObj[key] = required.includes(key) ? z.boolean() : z.boolean().optional();
                } else {
                    schemaObj[key] = required.includes(key) ? z.any() : z.any().optional();
                }
            }
            zodSchema = z.object(schemaObj);
        } else {
            zodSchema = z.object({});
        }

        return new DynamicStructuredTool({
            name: tool.name,
            description: tool.description ?? "",
            schema: zodSchema,
            func: async (args) => {
                const result = await client.callTool({
                    name: tool.name,
                    arguments: args,
                });

                const text = result.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join("\n");

                if (result.isError) {
                    throw new Error(text || "Unknown tool error");
                }

                return text;
            },
        });
    });

    // 6️⃣ Setup LLM (Groq)
    const llm = new ChatGroq({
        apiKey: process.env.GROQ_API_KEY,
        model: "llama-3.1-8b-instant",
        temperature: 0,
    });

    // 7️⃣ Create prompt template
    const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a helpful assistant that can search for items using the available tools."],
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad"),
    ]);

    // 8️⃣ Create agent
    const agent = await createToolCallingAgent({
        llm,
        tools,
        prompt,
    });

    // 9️⃣ Create executor
    const agentExecutor = new AgentExecutor({
        agent,
        tools,
        verbose: false,
        maxIterations: 5,
    });

    // 🔟 Run agent
    const result = await agentExecutor.invoke({
        input: "Find items related to machine learning",
    });

    console.log("\n🧠 Final Answer:\n");
    console.log(result.output);

    process.exit(0);
}

main();
