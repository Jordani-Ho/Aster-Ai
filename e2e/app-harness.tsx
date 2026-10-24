import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../app/src/App'
import { bootstrapIdentity } from '../app/src/core/onboarding'

// V2-28 整页 App 浏览器验收：预置“学生”角色，从 App 自己的入口走“先用社区模型开始”，
// 验证部署开了社区网关模型时学生不填自己的 Key 也能进首页；模型请求由浏览器路由替身。
const { store } = await bootstrapIdentity()
await store.put('settings', 'role', { role: 'student' })

Object.assign(window, {
  __v228: async () => ({
    community: await store.get('settings', 'community-model'),
    personal: await store.get('settings', 'personal-model'),
  }),
})

createRoot(document.getElementById('root')!).render(<App />)
