import type { LocalStore } from './core/store'
import { TemplateStudio } from './TemplateStudio'
import { PostureMetricsSettings } from './PostureMetricsSettings'
import './groundwork.css'
export function TemplateSettings({store}: {store: LocalStore}) {
  return <details><summary>模板</summary><TemplateStudio store={store} /><details><summary>体态指标</summary><PostureMetricsSettings store={store} /></details></details>
}
