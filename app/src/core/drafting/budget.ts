import { AGENT_BUDGET, validateAgentBudget, type AgentBudget } from '../../../../domain/tcm/agent-budget'

// V2-19：材料长度估算。浏览器里没有分词器，按字符保守估算：
// 汉字算 1 token、其他字符算 1/3 token，向上取整 —— 宁可高估、多减一点，
// 也不让请求顶到模型上限。上限数值在 domain/tcm/agent-budget.json。
export function estimateTokens(text: string): number {
  let han = 0
  let other = 0
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) han += 1
    else other += 1
  }
  return Math.ceil(han + other / 3)
}

export function requestTokens(messages: readonly { content: string }[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
}

export function budgetLimit(budget: AgentBudget = AGENT_BUDGET): number {
  validateAgentBudget(budget)
  return budget.maxRequestTokens
}
