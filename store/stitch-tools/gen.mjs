// Generate a Stitch screen from STITCH_GEN prompt -> STITCH_OUT/generated.{html,png}
import fs from 'node:fs'; import path from 'node:path'
const { STITCH_PROJECT: PROJ, STITCH_OUT: OUT, STITCH_GEN: GEN } = process.env
if (!process.env.STITCH_API_KEY) { console.error('NO_KEY'); process.exit(2) }
if (!GEN || !OUT) { console.error('need STITCH_GEN + STITCH_OUT'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const { stitch } = await import('@google/stitch-sdk')
const dl = async (u,d)=>{const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);fs.writeFileSync(d,Buffer.from(await r.arrayBuffer()))}
const project = stitch.project(PROJ)
const s = await project.generate(GEN)
console.log('GENERATED id='+(s.id||'?'))
let h; try{h=await s.getHtml()}catch{}
if(h) await dl(h, path.join(OUT,'generated.html'))
// Re-login: list all screens to populate screenshot.downloadUrl, then getImage()
let i
try{
  const screens = await project.screens()
  const fresh = screens.find(sc=>sc.id===s.id)??s
  i = await fresh.getImage()
}catch{}
if(i) await dl(i, path.join(OUT,'generated.png'))
console.log('DONE -> '+OUT+' html='+(h?'ok':'missing')+' png='+(i?'ok':'missing'))
