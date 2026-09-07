/**
 * LangGraph backend graph and model-provider seam.
 *
 * This is the server-side place to choose the model provider and graph behavior.
 * Provider secrets stay out of the frontend; the compiled `graph` is exposed to
 * LangGraph by `langgraph.json` under the `agent` assistant id.
 */
import { ChatOpenRouter } from "@langchain/openrouter";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

const model = new ChatOpenRouter({
  model: process.env.OPENROUTER_MODEL?.trim() || "openai/gpt-5.2",
  siteUrl: process.env.OPENROUTER_SITE_URL,
  siteName: process.env.OPENROUTER_APP_NAME,
});

const callModel = async (state: typeof MessagesAnnotation.State) => {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
};

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addEdge("__start__", "agent")
  .addEdge("agent", "__end__")
  .compile();
