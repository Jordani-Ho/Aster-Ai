import { parseTongueAbstract, tongueSummary } from '../../domain/tcm/tongue'
export function TongueFigure({record}:{record:unknown}) {
 try {
  const value=parseTongueAbstract(record)
  return <figure><div style={{maxWidth:180}} dangerouslySetInnerHTML={{__html:value.svg}}/><figcaption>舌象示意 · {value.shichen}时 · {value.jieqi} · {value.city}（模型读取，非诊断）<p>{tongueSummary(value.features)}</p></figcaption></figure>
 } catch {return <p role="alert">舌象记录无效，请重新拍摄。</p>}
}
