import dotenv from "dotenv";
import { createAgent } from "./agent_logic.js";

dotenv.config();

async function main() {
    try {
        const { agentExecutor } = await createAgent();
        console.log("✅ Agent ready");

        const input = process.argv[2] || "Find items related to machine learning";
        console.log(`🔎 Input: ${input}`);

        const result = await agentExecutor.invoke({
            input: input,
        });

        console.log("\n🧠 Final Answer:\n");
        console.log(result.output);

        process.exit(0);
    } catch (err) {
        console.error("❌ Agent failed:", err);
        process.exit(1);
    }
}

main();
