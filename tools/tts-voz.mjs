// tts-voz.mjs — gera FALA com o TTS da Gemini API, sempre na mesma voz.
//
// POR QUE A VOZ NÃO SAI DO VEO
// O Veo 3.1 gera áudio nativo e fala sincronizada (basta pôr a fala entre
// aspas no prompt), mas a documentação NÃO oferece nenhum controle de voz,
// sotaque ou identidade do locutor. Cada geração escolhe um timbre. Para uma
// personagem que precisa soar igual em toda peça, isso é inviável.
//
// A saída é separar: o Veo faz a imagem, o TTS faz a voz. As 30 vozes do
// Gemini TTS são nomeadas e determinísticas — o mesmo `voiceName` devolve o
// mesmo timbre em toda chamada, hoje e daqui a seis meses. É isso que dá à
// personagem uma voz própria.
//
// Uso:
//   node tools/tts-voz.mjs "<texto>" [--voz Kore] [--out fala.wav]
//   node tools/tts-voz.mjs "<texto>" --amostras            (uma por voz candidata)
//   node tools/tts-voz.mjs --vozes                         (lista as 30)
//
// Opções:
//   --voz <nome>     voz a usar (default: a definida em VOZ_PADRAO)
//   --modelo <id>    default gemini-3.1-flash-tts-preview
//   --out <arquivo>  default ./tts-out/<voz>-<timestamp>.wav
//   --amostras       gera uma amostra por voz de CANDIDATAS, para escolher
//
// O texto pode trazer direção de atuação em linguagem natural, que o modelo
// obedece: "Diga com calma:", "[sussurrando]", "[bem devagar]".

import fs from 'node:fs'
import path from 'node:path'

const API = 'https://generativelanguage.googleapis.com/v1beta'
const MODELO_PADRAO = 'gemini-3.1-flash-tts-preview'

// A voz padrão do projeto. Escolha por audição, não pelo adjetivo da tabela:
// os rótulos ("Bright", "Firm") descrevem mal o resultado em português.
//
// ⚠️ Se você tem um personagem recorrente, RESERVE a voz dele. Duas
// personagens com o mesmo timbre destroem, no áudio, exatamente a consistência
// que as reference images constroem na imagem — e isso passa despercebido na
// revisão peça a peça, só aparece quando alguém assiste a duas seguidas.
const VOZ_PADRAO = 'Autonoe'

// As 30 vozes, com o adjetivo que a documentação dá a cada uma.
const VOZES = {
  Zephyr: 'Bright', Puck: 'Upbeat', Charon: 'Informative', Kore: 'Firm',
  Fenrir: 'Excitable', Leda: 'Youthful', Orus: 'Firm', Aoede: 'Breezy',
  Callirrhoe: 'Easy-going', Autonoe: 'Bright', Enceladus: 'Breathy',
  Iapetus: 'Clear', Umbriel: 'Easy-going', Algieba: 'Smooth',
  Despina: 'Smooth', Erinome: 'Clear', Algenib: 'Gravelly',
  Rasalgethi: 'Informative', Laomedeia: 'Upbeat', Achernar: 'Soft',
  Alnilam: 'Firm', Schedar: 'Even', Gacrux: 'Mature',
  Pulcherrima: 'Forward', Achird: 'Friendly', Zubenelgenubi: 'Casual',
  Vindemiatrix: 'Gentle', Sadachbia: 'Lively', Sadaltager: 'Knowledgeable',
  Sulafat: 'Warm',
}

// Candidatas para a personagem, escolhidas pelo cânone da Character Bible:
// "inteligente, determinada, curiosa e autêntica; confiança tranquila".
// Fora ficaram as excitáveis (Fenrir, Sadachbia), as infantis (Leda), as
// graves masculinas (Algenib, Orus) e as sussurradas (Enceladus).
const CANDIDATAS = ['Erinome', 'Kore', 'Despina', 'Callirrhoe', 'Sulafat',
                    'Vindemiatrix', 'Schedar', 'Autonoe']

function lerChave() {
  try {
    const env = fs.readFileSync('.secrets/.env', 'utf8')
    const m = env.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* segue */ }
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  return null
}

function parseArgs(argv) {
  const pos = []; const opt = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--amostras') opt.amostras = true
    else if (argv[i] === '--vozes') opt.vozes = true
    else if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++ }
    else pos.push(argv[i])
  }
  return { pos, opt }
}

// O TTS devolve PCM cru (24 kHz, mono, 16 bits). Player nenhum abre isso sem
// cabeçalho — daí montar o WAV à mão, que são 44 bytes de RIFF na frente.
function pcmParaWav(pcm, taxa = 24000, canais = 1, bits = 16) {
  const blocoAlinhamento = canais * bits / 8
  const cab = Buffer.alloc(44)
  cab.write('RIFF', 0)
  cab.writeUInt32LE(36 + pcm.length, 4)
  cab.write('WAVE', 8)
  cab.write('fmt ', 12)
  cab.writeUInt32LE(16, 16)              // tamanho do bloco fmt
  cab.writeUInt16LE(1, 20)               // PCM sem compressão
  cab.writeUInt16LE(canais, 22)
  cab.writeUInt32LE(taxa, 24)
  cab.writeUInt32LE(taxa * blocoAlinhamento, 28)
  cab.writeUInt16LE(blocoAlinhamento, 32)
  cab.writeUInt16LE(bits, 34)
  cab.write('data', 36)
  cab.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([cab, pcm])
}

async function falar(key, modelo, texto, voz, destino) {
  const corpo = {
    contents: [{ parts: [{ text: texto }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voz } },
      },
    },
  }
  const r = await fetch(`${API}/models/${modelo}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 400)}`)

  const parte = j?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
  if (!parte) throw new Error(`sem áudio na resposta: ${JSON.stringify(j).slice(0, 400)}`)

  const pcm = Buffer.from(parte.inlineData.data, 'base64')
  // a taxa vem no mimeType, algo como "audio/L16;codec=pcm;rate=24000"
  const m = /rate=(\d+)/.exec(parte.inlineData.mimeType || '')
  const wav = pcmParaWav(pcm, m ? Number(m[1]) : 24000)
  fs.mkdirSync(path.dirname(destino), { recursive: true })
  fs.writeFileSync(destino, wav)
  return { bytes: wav.length, segundos: pcm.length / (24000 * 2) }
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2))

  if (opt.vozes) {
    console.log('As 30 vozes do Gemini TTS:\n')
    for (const [nome, adj] of Object.entries(VOZES)) {
      const marca = nome === VOZ_PADRAO ? '  <- canônica da personagem'
        : CANDIDATAS.includes(nome) ? '  (candidata)' : ''
      console.log(`  ${nome.padEnd(15)} ${adj.padEnd(16)}${marca}`)
    }
    return
  }

  const texto = pos.join(' ')
  if (!texto) {
    console.error('Uso: node tools/tts-voz.mjs "<texto>" [--voz Kore] [--out f.wav]')
    console.error('     node tools/tts-voz.mjs "<texto>" --amostras')
    console.error('     node tools/tts-voz.mjs --vozes')
    process.exit(1)
  }

  const key = lerChave()
  if (!key) { console.error('❌ GEMINI_API_KEY não encontrada em .secrets/.env'); process.exit(1) }
  const modelo = opt.modelo || MODELO_PADRAO

  if (opt.amostras) {
    const dir = opt.out || 'tts-out/amostras'
    console.log(`▶ gerando ${CANDIDATAS.length} amostras em ${dir}/\n`)
    for (const voz of CANDIDATAS) {
      const destino = path.join(dir, `voz-${voz}.wav`)
      try {
        const r = await falar(key, modelo, texto, voz, destino)
        console.log(`  ✅ ${voz.padEnd(14)} ${VOZES[voz].padEnd(14)} ${r.segundos.toFixed(1)}s`)
      } catch (e) {
        console.log(`  ❌ ${voz.padEnd(14)} ${e.message.slice(0, 90)}`)
      }
    }
    console.log(`\nOuça as ${CANDIDATAS.length} e escolha. A escolhida vira VOZ_PADRAO neste arquivo.`)
    return
  }

  const voz = opt.voz || VOZ_PADRAO
  if (!VOZES[voz]) {
    console.error(`❌ voz desconhecida: ${voz}. Use --vozes para ver as 30.`)
    process.exit(1)
  }
  const destino = opt.out || path.join('tts-out',
    `${voz}-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`)
  const r = await falar(key, modelo, texto, voz, destino)
  console.log(`✅ ${voz} (${VOZES[voz]}) · ${r.segundos.toFixed(1)}s · ${destino}`)
}

main().catch((e) => { console.error('❌', e?.message || e); process.exit(1) })
