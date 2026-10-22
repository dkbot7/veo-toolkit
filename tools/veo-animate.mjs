// veo-animate.mjs — gera VÍDEO com a API do Google Veo (Gemini API).
// Parte do pipeline de conteúdo (ver config/PROMPTS-IMAGEM-E-VEO.md). Roda LOCAL (Node) — o polling
// da operação longa (minutos) não tem o limite de CPU do Cloudflare Worker.
//
// TRÊS MODOS:
//
//   1) IMAGEM → VÍDEO (o original: anima uma imagem pronta)
//      node tools/veo-animate.mjs <imagem.png> "<prompt de animação>"
//
//   2) TEXTO → VÍDEO (sem imagem nenhuma)
//      node tools/veo-animate.mjs "<prompt da cena>"
//
//   3) TEXTO + PERSONAGEM → VÍDEO  ← é o que mantém a personagem consistente
//      node tools/veo-animate.mjs "<prompt da cena>" --ref rosto.png --ref corpo.png
//
//      `--ref` pode repetir até 3 vezes. São as "reference images" do Veo 3.1:
//      o modelo preserva a aparência da pessoa/produto em vez de inventar
//      alguém parecido a cada geração. É o que dispensa gerar a imagem antes
//      no ChatGPT — a folha de personagem entra direto aqui.
//
// Opções (com defaults):
//   --model veo-3.1-fast-generate-preview   (fast $0,10-0,12/s; -generate-preview $0,40/s; -lite $0,05-0,08/s)
//   --aspect 9:16        (9:16 story/reel | 16:9)
//   --duration 8         (4 | 6 | 8 — 8 é OBRIGATÓRIO com --ref, 1080p ou 4k)
//   --resolution 1080p   (720p | 1080p | 4k)
//   --out <arquivo.mp4>  (default: ./veo-out/<timestamp>.mp4)
//   --negative "<negative prompt>"
//   --dry-run            (monta e valida a requisição, mostra o custo, NÃO gera)
//   --no-audio           (vídeo mudo — contorna o filtro de segurança do áudio)
//
// Chave: lê GEMINI_API_KEY de .secrets/.env  OU  .secrets/gemini_api_key.txt (NUNCA imprime a chave).
// O Veo não tem camada gratuita: exige projeto com billing ativo.
//
// ⚠️ O vídeo gerado some do servidor do Google em ~2 dias — este script já baixa o MP4 na hora.

import fs from 'node:fs'
import path from 'node:path'

const API = 'https://generativelanguage.googleapis.com/v1beta'
const MAX_REFS = 3

// preço por segundo (USD), da página de pricing da Gemini API.
// Serve para avisar quanto a geração vai custar ANTES de disparar.
const PRECO = {
  'veo-3.1-generate-preview':      { '720p': 0.40, '1080p': 0.40, '4k': 0.60 },
  'veo-3.1-fast-generate-preview': { '720p': 0.10, '1080p': 0.12, '4k': 0.30 },
  'veo-3.1-lite-generate-preview': { '720p': 0.05, '1080p': 0.08 },
}

function lerChave() {
  // 1) .secrets/.env  → GEMINI_API_KEY=...
  try {
    const env = fs.readFileSync('.secrets/.env', 'utf8')
    const m = env.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* segue */ }
  // 2) .secrets/gemini_api_key.txt
  try {
    const t = fs.readFileSync('.secrets/gemini_api_key.txt', 'utf8').trim()
    if (t) return t.replace(/^["']|["']$/g, '')
  } catch { /* segue */ }
  // 3) variável de ambiente
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  return null
}

function parseArgs(argv) {
  const pos = []
  const opt = {}
  const refs = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') { refs.push(argv[i + 1]); i++ }          // acumula, não sobrescreve
    else if (argv[i] === '--dry-run') { opt['dry-run'] = true }
    else if (argv[i] === '--no-audio') { opt['no-audio'] = true }
    else if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++ }
    else pos.push(argv[i])
  }
  return { pos, opt, refs }
}

const mimeDe = (p) => {
  const e = path.extname(p).toLowerCase()
  return e === '.png' ? 'image/png' : (e === '.jpg' || e === '.jpeg') ? 'image/jpeg' : e === '.webp' ? 'image/webp' : 'image/png'
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b64De = (p) => fs.readFileSync(p).toString('base64')

// A API aceita a imagem em dois formatos e a documentação usa um em cada
// página. `bytesBase64Encoded` é o que este script já usava e que sabidamente
// funciona; `inlineData` é o que aparece nos exemplos de referenceImages.
// Em vez de apostar, monta nos dois e reenvia se o primeiro for recusado.
const imgBytes  = (p) => ({ bytesBase64Encoded: b64De(p), mimeType: mimeDe(p) })
const imgInline = (p) => ({ inlineData: { data: b64De(p), mimeType: mimeDe(p) } })

function montarInstance(prompt, imagem, refs, formato) {
  const img = formato === 'inline' ? imgInline : imgBytes
  const inst = { prompt }
  if (imagem) inst.image = img(imagem)
  if (refs.length) {
    inst.referenceImages = refs.map((r) => ({ image: img(r), referenceType: 'asset' }))
  }
  return inst
}

async function main() {
  const { pos, opt, refs } = parseArgs(process.argv.slice(2))

  // Retrocompatível: 2 posicionais = (imagem, prompt); 1 posicional = só prompt.
  let imagem = null
  let prompt = null
  if (pos.length >= 2) { imagem = pos[0]; prompt = pos.slice(1).join(' ') }
  else if (pos.length === 1) { prompt = pos[0] }
  if (opt.image) imagem = opt.image

  if (!prompt) {
    console.error('Uso:')
    console.error('  imagem→vídeo : node tools/veo-animate.mjs <imagem> "<prompt>"')
    console.error('  texto→vídeo  : node tools/veo-animate.mjs "<prompt>"')
    console.error('  personagem   : node tools/veo-animate.mjs "<prompt>" --ref rosto.png --ref corpo.png')
    console.error('Opções: --model --aspect 9:16 --duration 8 --resolution 1080p --out f.mp4 --negative ".." --dry-run')
    process.exit(1)
  }
  if (imagem && !fs.existsSync(imagem)) { console.error('❌ imagem não encontrada:', imagem); process.exit(1) }
  for (const r of refs) {
    if (!r || !fs.existsSync(r)) { console.error('❌ referência não encontrada:', r); process.exit(1) }
  }
  if (refs.length > MAX_REFS) {
    console.error(`❌ o Veo aceita no máximo ${MAX_REFS} imagens de referência (foram passadas ${refs.length}).`)
    process.exit(1)
  }

  const model = opt.model || 'veo-3.1-fast-generate-preview'
  const aspectRatio = opt.aspect || '9:16'
  let durationSeconds = Number(opt.duration || 8)
  const resolution = opt.resolution || '1080p'

  // Regras da própria API, verificadas na documentação. Sem estas travas o
  // erro só aparece depois de a requisição ser recusada — e com mensagem
  // genérica, que não diz qual combinação é a proibida.
  if (refs.length && durationSeconds !== 8) {
    console.log(`ℹ com imagens de referência a duração TEM de ser 8s (era ${durationSeconds}) — ajustado.`)
    durationSeconds = 8
  }
  if ((resolution === '1080p' || resolution === '4k') && durationSeconds !== 8) {
    console.log(`ℹ ${resolution} exige 8s (era ${durationSeconds}) — ajustado.`)
    durationSeconds = 8
  }
  if (resolution === '4k' && model.includes('lite')) {
    console.error('❌ o Veo 3.1 Lite não gera em 4k.'); process.exit(1)
  }

  const out = opt.out || path.join('veo-out', `${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`)

  // personGeneration: com imagem inicial ou referências, a API só aceita
  // 'allow_adult'. Em texto→vídeo puro, 'allow_all' é o valor permitido.
  const personGeneration = (imagem || refs.length) ? 'allow_adult' : 'allow_all'
  const parameters = { aspectRatio, durationSeconds, resolution, sampleCount: 1, personGeneration }

  // ⚠️ NEGATIVE PROMPT NÃO CONVIVE COM REFERENCE IMAGES.
  // A API responde 400 "Negative prompt is not supported in your use case" —
  // e o erro só aparece depois de subir os megabytes das referências.
  // Quando há --ref, as restrições têm de entrar no prompt positivo, ditas
  // pelo que se QUER ver: "plain empty black background" no lugar de
  // "no bookshelves".
  if (opt.negative && refs.length) {
    console.log('ℹ --negative foi IGNORADO: a API não aceita negative prompt junto')
    console.log('  com imagens de referência. Descreva o que quer ver, no prompt.')
  } else if (opt.negative) {
    parameters.negativePrompt = opt.negative
  }

  // ⚠️ --no-audio NÃO FUNCIONA NO VEO 3.1 (nem no fast). A ideia era contornar
  // o filtro que barra a trilha gerada pelo próprio modelo:
  //   "We encountered an issue with the audio for your prompt, which means we
  //    could not create your video."
  // A API responde 400: "`generateAudio` isn't supported by this model."
  // O áudio no Veo 3.1 é nativo e não se desliga. Quando o filtro de áudio
  // barra uma cena, o caminho é REESCREVER a cena — não desligar o som.
  // A flag fica aqui para o dia em que um modelo aceitar; hoje ela só avisa.
  if (opt['no-audio']) {
    console.log('ℹ --no-audio IGNORADO: o Veo 3.1 tem áudio nativo e não aceita')
    console.log('  generateAudio=false. Se o filtro de áudio barrar, reescreva a cena.')
  }

  const preco = PRECO[model]?.[resolution]
  const custo = preco ? `~US$ ${(preco * durationSeconds).toFixed(2)}` : 'custo desconhecido'
  const modo = refs.length ? `personagem (${refs.length} ref)` : imagem ? 'imagem→vídeo' : 'texto→vídeo'

  console.log(`▶ ${modo} · ${model} · ${aspectRatio} ${durationSeconds}s ${resolution} · ${custo}`)
  if (imagem) console.log(`  imagem inicial: ${imagem}`)
  refs.forEach((r) => console.log(`  referência: ${r}`))

  if (opt['dry-run']) {
    const inst = montarInstance(prompt, imagem, refs, 'bytes')
    const resumo = JSON.stringify({ instances: [inst], parameters }, (k, v) =>
      (k === 'bytesBase64Encoded' || k === 'data') ? `<${String(v).length} bytes base64>` : v, 2)
    console.log('\n--- requisição (NÃO enviada) ---\n' + resumo)
    return
  }

  const key = lerChave()
  if (!key) { console.error('❌ GEMINI_API_KEY não encontrada. Coloque em .secrets/.env (GEMINI_API_KEY=...) ou .secrets/gemini_api_key.txt'); process.exit(1) }

  // 1) INICIAR — com fallback de formato da imagem
  let startJ = null
  let startR = null
  for (const formato of ['bytes', 'inline']) {
    const body = { instances: [montarInstance(prompt, imagem, refs, formato)], parameters }
    startR = await fetch(`${API}/models/${model}:predictLongRunning`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    startJ = await startR.json().catch(() => ({}))
    if (startR.ok) break
    const msg = JSON.stringify(startJ)
    const eCampo = startR.status === 400 && /inlineData|bytesBase64Encoded|Invalid JSON|unknown name/i.test(msg)
    if (!eCampo || formato === 'inline') {
      console.error(`❌ falha ao iniciar (HTTP ${startR.status}):`, msg.slice(0, 700))
      process.exit(1)
    }
    console.log('ℹ o formato de imagem foi recusado; repetindo com inlineData…')
  }

  const opName = startJ.name
  if (!opName) { console.error('❌ sem operation name na resposta:', JSON.stringify(startJ).slice(0, 600)); process.exit(1) }
  console.log('⏳ operação:', opName)

  // 2) POLLAR (até ~12 min) — a documentação recomenda intervalo de 10s
  let done = null
  for (let i = 0; i < 72; i++) {
    await sleep(10000)
    const r = await fetch(`${API}/${opName}`, { headers: { 'x-goog-api-key': key } })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { console.error(`❌ falha no polling (HTTP ${r.status}):`, JSON.stringify(j).slice(0, 400)); process.exit(1) }
    if (j.done) { done = j; break }
    process.stdout.write('.')
  }
  process.stdout.write('\n')
  if (!done) { console.error('❌ timeout esperando o vídeo (>12min).'); process.exit(1) }
  if (done.error) { console.error('❌ erro na geração:', JSON.stringify(done.error).slice(0, 600)); process.exit(1) }

  // 3) BAIXAR
  const uri = done?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    || done?.response?.generatedVideos?.[0]?.video?.uri
  if (!uri) { console.error('❌ não achei a URI do vídeo na resposta:', JSON.stringify(done.response).slice(0, 600)); process.exit(1) }
  const vid = await fetch(uri, { headers: { 'x-goog-api-key': key } })
  if (!vid.ok) { console.error(`❌ falha ao baixar o MP4 (HTTP ${vid.status})`); process.exit(1) }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.from(await vid.arrayBuffer()))
  console.log('✅ vídeo salvo em:', out)
}

main().catch((e) => { console.error('❌', e?.message || e); process.exit(1) })
