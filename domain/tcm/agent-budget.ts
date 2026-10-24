import budgetJson from './agent-budget.json'

// V2-19：老师智能体每次调用前估算材料长度的上限。
// 默认 16000 = 常见模型 32k 上下文的一半，另一半留给回复、提示词误差和保守估算；
// 这是数据不是代码：换模型或换部署时只改 JSON，不改任何调用代码。
export interface AgentBudget {
  version: number
  maxRequestTokens: number
}

export const AGENT_BUDGET = budgetJson as AgentBudget

export function validateAgentBudget(value: AgentBudget): void {
  if (!value || typeof value !== 'object') throw new Error('额度配置无效')
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('额度配置版本无效')
  if (!Number.isSafeInteger(value.maxRequestTokens) || value.maxRequestTokens <= 0) throw new Error('额度上限必须是正整数')
}
