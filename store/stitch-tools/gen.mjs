// Generate a Stitch screen from STITCH_GEN prompt -> STITCH_OUT/generated.{html,png}
import fs from 'node:fs'; import path from 'node:path'
const { STITCH_PROJECT: PROJ, STITCH_OUT: OUT, STITCH_GEN: GEN } = process.env
if (!process.env.STITCH_API_KEY) { console.error('NO_KEY'); process.exit(2) }
if (!GEN || !OUT) { console.error('need STITCH_GEN + STITCH_OUT'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const { stitch } = await import('@google/stitch-sdk')
const dl = async (u,d)=>{const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);fs.writeFileSync(d,Buffer.from(await r.arrayBuffer()))}
const s = await stitch.project(PROJ).generate(GEN)
let h,i; try{h=await s.getHtml()}catch{} try{i=await s.getImage()}catch{}
if(h) await dl(h, path.join(OUT,'generated.html'))
if(i) await dl(i, path.join(OUT,'generated.png'))
console.log('GENERATED id='+(s.id||'?')+' -> '+OUT)
