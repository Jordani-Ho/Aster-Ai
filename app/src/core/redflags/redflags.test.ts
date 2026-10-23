import { afterEach, describe, expect, it, vi } from 'vitest'
import { check, checkWithModel, redFlagCategories, validateDocument } from './index'

interface Samples { hit: string[]; miss: string[] }

// 全部为合成的日常口语例句，不是真实病人的话。
const samples: Record<string, Samples> = {
  'RF-01': {
    hit: [
      '胸口闷，还一直冒冷汗',
      '心口痛，疼了二十多分钟',
      '胸口痛，左臂也发麻',
      '胸口压着疼，喘不上气',
    ],
    miss: [
      '昨天跑步胸口有点闷，休息一下就好了',
      '胸口闷了五分钟，深呼吸一下好多了',
      '胸口被轻轻撞了一下，揉了揉就不疼了',
    ],
  },
  'RF-02': {
    hit: [
      '我妈突然半边身子没劲，说话也含糊',
      '刚才口角歪了一下，现在还麻',
      '右眼突然看不见了',
      '左边一侧无力，端不住碗',
    ],
    miss: [
      '最近总觉得累，手脚有点酸',
      '昨晚没睡好，今天说话有点快',
      '眼睛干涩，看东西有点模糊',
    ],
  },
  'RF-03': {
    hit: [
      '走两步就喘不上气，得坐下歇着',
      '刚才眼前一黑，差点晕过去',
      '孩子抽筋不停，怎么叫都没反应',
      '憋气，胸口像压了块石头',
    ],
    miss: [
      '鼻子有点堵，呼吸还行',
      '蹲久了站起来有点晕，坐一会儿就好',
      '最近压力大，偶尔叹气，觉得气短',
    ],
  },
  'RF-04': {
    hit: [
      '烧了两天，一直高烧不退',
      '突然剧烈头痛，还吐了',
      '肚子痛得打滚，直不起腰',
      '头从来没这么痛',
    ],
    miss: [
      '有点低烧，三十七度多，多喝水',
      '昨晚没睡好，头有点沉',
      '吃坏了肚子，拉了一次，已经好了',
    ],
  },
  'RF-05': {
    hit: [
      '伤口一直血止不住，赶紧去医院',
      '咳出来有血，吐血了',
      '孕期出血，赶紧去医院',
      '摔得很重，站不起来',
    ],
    miss: [
      '手指被纸划了一下，出了点血',
      '最近便秘，大便有点干',
      '膝盖磕了一下，有点青',
    ],
  },
  'RF-06': {
    hit: [
      '我真的不想活了',
      '有时候觉得活着没意思',
      '我想伤害自己',
      '最近总想死',
    ],
    miss: [
      '最近心情不好，压力有点大',
      '看完那个沉重的电影，心情有点低落',
      '熬夜太多，白天没精神',
    ],
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('M1-04 急症红线引擎', () => {
  it('每一类都有至少 3 条应命中例句和 3 条不应误报例句', () => {
    for (const category of redFlagCategories) {
      const sample = samples[category.id]
      expect(sample, category.id).toBeDefined()
      expect(sample.hit.length, category.id).toBeGreaterThanOrEqual(3)
      expect(sample.miss.length, category.id).toBeGreaterThanOrEqual(3)
    }
  })

  it('应命中的例句命中正确的类别', () => {
    for (const category of redFlagCategories) {
      for (const sentence of samples[category.id].hit) {
        const result = check(sentence)
        expect(result.hit, sentence).toBe(true)
        expect(result.category?.id, sentence).toBe(category.id)
        expect(result.matched.some(word => category.keywords.includes(word)), sentence).toBe(true)
        expect(result.source, sentence).toBe('local')
      }
    }
  })

  it('不应误报的例句不命中任何类别', () => {
    for (const category of redFlagCategories) {
      for (const sentence of samples[category.id].miss) {
        const result = check(sentence)
        expect(result.hit, sentence).toBe(false)
        expect(result.category, sentence).toBeNull()
        expect(result.matched, sentence).toEqual([])
      }
    }
  })

  it('断网时照常工作，只做本地匹配', () => {
    const fetchSpy = vi.fn(() => { throw new Error('断网') })
    vi.stubGlobal('fetch', fetchSpy)
    const result = check('胸口闷，还一直冒冷汗')
    expect(result.hit).toBe(true)
    expect(result.category?.id).toBe('RF-01')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('同时命中急救与自伤时按自伤类标记', () => {
    const result = check('胸口痛，还冒冷汗，真的不想活了')
    expect(result.hit).toBe(true)
    expect(result.category?.action).toBe('crisis')
    expect(result.category?.id).toBe('RF-06')
  })

  it('第二层返回不命中时，第一层命中依然有效', async () => {
    const judge = vi.fn(async () => ({ hit: false }))
    const result = await checkWithModel('胸口闷，还一直冒冷汗', judge)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(result.hit).toBe(true)
    expect(result.category?.id).toBe('RF-01')
    expect(result.source).toBe('local')
  })

  it('第二层抛错也不能取消第一层命中', async () => {
    const result = await checkWithModel('胸口闷，还一直冒冷汗', async () => { throw new Error('模型不可用') })
    expect(result.hit).toBe(true)
    expect(result.category?.id).toBe('RF-01')
  })

  it('第二层只能增加命中，不能编造清单里没有的类别', async () => {
    const added = await checkWithModel('最近心里堵得慌', async () => ({ hit: true, categoryId: 'RF-06' }))
    expect(added.hit).toBe(true)
    expect(added.category?.id).toBe('RF-06')
    expect(added.source).toBe('model')
    const invented = await checkWithModel('最近心里堵得慌', async () => ({ hit: true, categoryId: 'RF-99' }))
    expect(invented.hit).toBe(false)
  })

  it('繁体输入先转简体再匹配，空白不影响匹配', () => {
    const traditional: [string, string][] = [
      ['頭痛欲裂', 'RF-04'],
      ['說話不清楚，嘴歪了', 'RF-02'],
      ['活著沒意思', 'RF-06'],
    ]
    for (const [sentence, categoryId] of traditional) {
      expect(check(sentence).category?.id, sentence).toBe(categoryId)
    }
    expect(check('胸 口 悶，還 冒 冷 汗').category?.id).toBe('RF-01')
  })

  it('durationWords：出现持续类说法时按 15 分钟以上处理', () => {
    const document = validateDocument({
      version: 1,
      categories: [{
        id: 'RF-01',
        name: '测试类别',
        action: 'emergency',
        keywords: ['胸口闷'],
        aggravators: ['冷汗'],
        durationWords: ['好一会儿', '一直'],
        rule: 'keyword AND (aggravator OR duration>=15min OR durationWord)',
      }],
      contacts: {},
    })
    expect(check('胸口闷，好一会儿了', document).category?.id).toBe('RF-01')
    expect(check('胸口闷，一直不舒服', document).category?.id).toBe('RF-01')
    expect(check('胸口闷', document).hit).toBe(false)
  })

  it('同时命中急救与自伤时 actions 保留两类，界面不显示号码', () => {
    const result = check('胸口痛，还冒冷汗，真的不想活了')
    expect(result.actions).toEqual(['emergency', 'crisis'])
  })

  it('只命中自伤时标记 crisis，不生成任何号码提示', () => {
    const result = check('我真的不想活了')
    expect(result.hit).toBe(true)
    expect(result.actions).toEqual(['crisis'])
  })


  it('durationWords：清单里的持续说法按 15 分钟以上处理', () => {
    for (const sentence of ['胸口闷了十几分钟', '胸口闷，好一会儿了', '胸口闷，一直不舒服']) {
      expect(check(sentence).category?.id, sentence).toBe('RF-01')
    }
  })

  it('审核探测句：14 句必须命中，单独“心口痛”不命中', () => {
    const probes: { text: string; categoryId: string | null }[] = [
      { text: '胸口疼得厉害，出了一身冷汗', categoryId: 'RF-01' },
      { text: '心口疼，左边胳膊也疼，冒虚汗', categoryId: 'RF-01' },
      { text: '胸口很闷，喘不过气来', categoryId: 'RF-01' },
      { text: '头疼得像要裂开一样', categoryId: 'RF-04' },
      { text: '肚子疼得在床上打滚', categoryId: 'RF-04' },
      { text: '我爸突然说不出话，嘴也歪了', categoryId: 'RF-02' },
      { text: '一边手抬不起来', categoryId: 'RF-02' },
      { text: '孩子烧到三十九度八，一直不退', categoryId: 'RF-04' },
      { text: '拉的大便是黑的', categoryId: 'RF-05' },
      { text: '心口痛', categoryId: null },
      { text: '頭痛欲裂', categoryId: 'RF-04' },
      { text: '說話不清楚，嘴歪了', categoryId: 'RF-02' },
      { text: '最近真的不想活了', categoryId: 'RF-06' },
      { text: '活著沒意思', categoryId: 'RF-06' },
      { text: '覺得自己是個負擔，想一了百了', categoryId: 'RF-06' },
    ]
    for (const probe of probes) {
      const result = check(probe.text)
      expect(result.hit, probe.text).toBe(probe.categoryId !== null)
      expect(result.category?.id ?? null, probe.text).toBe(probe.categoryId)
    }
  })

  it('清单里出现未实现的规则时直接报错，不静默放过', async () => {
    const { validateDocument } = await import('./index')
    expect(() => validateDocument({
      version: 1,
      categories: [{ id: 'RF-99', name: '未知规则', action: 'emergency', keywords: ['测试'], rule: 'regex /x/' }],
      contacts: {},
    })).toThrow()
  })
})
