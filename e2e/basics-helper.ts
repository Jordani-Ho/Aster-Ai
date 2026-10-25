import { expect, type Page } from '@playwright/test'

// V2-23：新学生进馆第一屏是基础信息（发起人：出生日期等是进馆必填项）。合成学生用这里填好再进首页。
export async function fillJoinBasics(page: Page, alias = '合成学生'): Promise<void> {
  await expect(page.getByRole('heading', { name: '进馆：先填基础信息', exact: true })).toBeVisible()
  const name = page.getByLabel('称呼', { exact: true })
  if (!(await name.inputValue())) await name.fill(alias)
  await page.getByLabel('男', { exact: true }).check()
  await page.getByLabel('出生日期', { exact: true }).fill('1990-05-06')
  await page.getByLabel('出生时辰', { exact: true }).selectOption('unknown')
  await page.getByLabel('出生地', { exact: true }).selectOption('北京市')
  const city = page.getByLabel('居住城市', { exact: true })
  if (!(await city.inputValue())) await city.selectOption('北京市')
  for (const label of ['既往病史', '在用药', '过敏']) await page.getByLabel(label, { exact: true }).fill('无')
  await page.getByLabel('平时几点起', { exact: true }).fill('07:00')
  await page.getByLabel('平时几点睡', { exact: true }).fill('23:00')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('[data-page=student-today]')).toBeVisible()
}
