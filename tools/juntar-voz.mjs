// juntar-voz.mjs — casa a voz da personagem (TTS) com o vídeo (Veo).
//
// POR QUE ESTE PASSO EXISTE
// O Veo gera áudio nativo, mas não deixa escolher a voz — sorteia o timbre a
// cada geração. A voz da personagem vem do TTS, que é determinístico. Sobra o
// problema de juntar as duas coisas, e ele não é só "colar o WAV por cima":
// vídeo tem 8 s exatos e a fala tem a duração que tiver.
//
// O QUE ELE FAZ COM A DIFERENÇA DE DURAÇÃO
//   fala MAIOR que o vídeo  → acelera a fala até o limite de ACELERACAO_MAX.
//                             Se ainda não couber, PARA e diz quantas palavras
//                             tirar — cortar a frase no meio é pior que falhar.
//   fala MENOR que o vídeo  → completa com silêncio (--alinhar diz onde).
//
// Uso:
//   node tools/juntar-voz.mjs <video.mp4> <voz.wav> [--out final.mp4]
//
// Opções:
//   --modo substituir|mixar   default mixar — mantém o ambiente do Veo baixo
//                             por trás da voz, o que soa mais natural que
//                             uma locução no vácuo
//   --ambiente -18            volume do áudio original em dB, no modo mixar
//   --alinhar inicio|centro|fim   onde a fala fica, se sobrar vídeo (default centro)
//   --atraso 0.4              segundos de silêncio antes da fala começar
//
// Precisa de ffmpeg e ffprobe no PATH.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Acima de ~1,15x a fala fica com aquele timbre de "acelerado", que denuncia
// o truque. Abaixo disso o ouvido não percebe.
const ACELERACAO_MAX = 1.15
const PALAVRAS_POR_SEGUNDO = 2.35   // medido nas 8 amostras de voz, em pt-BR

function parseArgs(argv) {
  const pos = []; const opt = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++ }
    else pos.push(argv[i])
  }
  return { pos, opt }
}

function duracao(arquivo) {
  const saida = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', arquivo,
  ], { encoding: 'utf8' })
  const d = parseFloat(saida.trim())
  if (!isFinite(d)) throw new Error(`não consegui medir a duração de ${arquivo}`)
  return d
}

function temAudio(arquivo) {
  const saida = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
    '-of', 'csv=p=0', arquivo,
  ], { encoding: 'utf8' })
  return saida.trim().length > 0
}

function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2))
  const [video, voz] = pos
  if (!video || !voz) {
    console.error('Uso: node tools/juntar-voz.mjs <video.mp4> <voz.wav> [--out final.mp4]')
    console.error('Opções: --modo mixar|substituir --ambiente -18 --alinhar centro --atraso 0.4')
    process.exit(1)
  }
  for (const f of [video, voz]) {
    if (!fs.existsSync(f)) { console.error('❌ não encontrado:', f); process.exit(1) }
  }

  const modo = opt.modo || 'mixar'
  const ambiente = Number(opt.ambiente ?? -18)
  const alinhar = opt.alinhar || 'centro'
  const atraso = Number(opt.atraso ?? 0)
  const out = opt.out || video.replace(/\.mp4$/i, '') + '-com-voz.mp4'

  const dv = duracao(video)
  const da = duracao(voz)
  console.log(`vídeo ${dv.toFixed(2)}s · voz ${da.toFixed(2)}s`)

  // --- resolve a diferença de duração -------------------------------------
  const disponivel = dv - atraso
  let atempo = 1
  let inicio = atraso

  if (da > disponivel) {
    atempo = da / disponivel
    if (atempo > ACELERACAO_MAX) {
      const cabe = Math.floor(disponivel * ACELERACAO_MAX * PALAVRAS_POR_SEGUNDO)
      const sobra = da - disponivel * ACELERACAO_MAX
      console.error(`\n❌ a fala não cabe no vídeo.`)
      console.error(`   Seriam necessários ${atempo.toFixed(2)}x de aceleração, e acima de`)
      console.error(`   ${ACELERACAO_MAX}x a voz fica com timbre de "acelerado" — o truque aparece.`)
      console.error(`\n   Escolha um dos três:`)
      console.error(`   • encurte o texto em ~${Math.ceil(sobra * PALAVRAS_POR_SEGUNDO)} palavras`)
      console.error(`     (nesta peça cabem ~${cabe} palavras no total)`)
      console.error(`   • gere um vídeo mais longo (extensão de cena: +7s por chamada, 720p)`)
      console.error(`   • aumente ACELERACAO_MAX neste arquivo, ciente do custo sonoro`)
      process.exit(1)
    }
    console.log(`  fala ${(atempo).toFixed(3)}x mais rápida para caber (limite ${ACELERACAO_MAX}x)`)
  } else {
    const folga = disponivel - da
    if (alinhar === 'centro') inicio = atraso + folga / 2
    else if (alinhar === 'fim') inicio = atraso + folga
    if (folga > 0.05) {
      console.log(`  sobram ${folga.toFixed(2)}s de vídeo — fala alinhada ao ${alinhar}` +
        ` (começa em ${inicio.toFixed(2)}s)`)
    }
  }

  // --- monta o filtro de áudio --------------------------------------------
  // adelay quer milissegundos; atempo aceita 0.5–2.0 numa única passagem, e
  // aqui nunca passa de ACELERACAO_MAX, então uma basta.
  const cadeiaVoz = [
    atempo !== 1 ? `atempo=${atempo.toFixed(4)}` : null,
    inicio > 0.001 ? `adelay=${Math.round(inicio * 1000)}|${Math.round(inicio * 1000)}` : null,
    // a voz do TTS vem baixa em relação ao ambiente do Veo; normaliza para
    // um nível de fala de rede social
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ].filter(Boolean).join(',')

  const videoTemAudio = temAudio(video)
  let filtro
  let mapaAudio

  if (modo === 'mixar' && videoTemAudio) {
    filtro = `[1:a]${cadeiaVoz}[voz];[0:a]volume=${ambiente}dB[amb];` +
             `[amb][voz]amix=inputs=2:duration=first:dropout_transition=0[a]`
    mapaAudio = '[a]'
    console.log(`  modo mixar — ambiente do vídeo em ${ambiente}dB sob a voz`)
  } else {
    if (modo === 'mixar' && !videoTemAudio) {
      console.log('  ℹ o vídeo não tem trilha de áudio; mixar vira substituir')
    }
    filtro = `[1:a]${cadeiaVoz}[a]`
    mapaAudio = '[a]'
    console.log('  modo substituir — só a voz')
  }

  const args = [
    '-y', '-i', video, '-i', voz,
    '-filter_complex', filtro,
    '-map', '0:v', '-map', mapaAudio,
    '-c:v', 'copy',                    // não recodifica a imagem: nada se perde
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    out,
  ]
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })

  const tam = fs.statSync(out).size / 1e6
  console.log(`\n✅ ${out}  (${duracao(out).toFixed(2)}s, ${tam.toFixed(1)} MB)`)
}

try { main() } catch (e) {
  const msg = e?.stderr?.toString?.() || e?.message || String(e)
  console.error('❌', msg.slice(-800))
  process.exit(1)
}
