# veo-toolkit

Três ferramentas de linha de comando para gerar vídeo com o **Veo 3.1** e voz
com o **Gemini TTS**, pela Gemini API. Node puro, sem dependência.

O que este repositório tem de diferente é a **seção de armadilhas**: um punhado
de comportamentos da API que não estão na documentação e que só aparecem depois
de um HTTP 400 — ou de uma geração cobrada que veio errada.

```bash
# imagem → vídeo
node tools/veo-animate.mjs foto.png "slow dolly in, steam rising, keep everything else still"

# texto + personagem consistente (até 3 referências)
node tools/veo-animate.mjs "ela abre o notebook" --ref rosto.png --ref corpo.png

# voz
node tools/tts-voz.mjs "o texto a ser narrado" --voz Autonoe --out voz.wav

# juntar voz e vídeo
node tools/juntar-voz.mjs video.mp4 voz.wav --out final.mp4
```

## Antes de começar

O **Veo não tem camada gratuita** — precisa de um projeto com billing ativo.
Coloque a chave em `.secrets/.env`:

```
GEMINI_API_KEY=sua-chave-aqui
```

Todo comando aceita `--dry-run`: monta a requisição, valida, **mostra o custo
estimado** e não gera nada. Use sempre na primeira vez.

> O `--dry-run` **funciona sem chave nenhuma** — dá para clonar e ver a
> requisição que seria enviada, e quanto custaria, antes de decidir se vale
> ativar billing.

## As armadilhas

Cada uma destas custou uma tentativa — algumas, várias.

### `negativePrompt` não convive com `referenceImages`

Mandar os dois na mesma requisição devolve **HTTP 400**. Não é documentado, e a
mensagem de erro não diz qual dos dois é o problema.

**O que fazer:** mova a restrição para o prompt positivo. Em vez de
`--negative "sem texto na tela"`, escreva a cena sem aquilo. O script avisa e
ignora o `--negative` quando há `--ref`.

### `generateAudio: false` não existe no Veo 3.1

O Veo 3.1 tem áudio nativo e **não há como desligar**. O parâmetro existia em
versões anteriores; mandá-lo agora dá **HTTP 400**.

Não há vídeo mudo pela API — se você precisa de silêncio, remova a faixa depois,
com ffmpeg.

### O filtro de segurança do áudio barra a CENA, não a frase

Este é o mais caro de descobrir, porque a intuição está errada.

Quando a geração é recusada por áudio, o reflexo é reescrever ou apagar a linha
`Audio:` do prompt. **Não adianta** — o filtro avalia a cena inteira. É a ação
descrita que precisa mudar, não a fala.

### Com `--ref`, a duração TEM que ser 8 segundos

Qualquer outro valor junto de `referenceImages` é rejeitado. Não é
arredondamento: é 8, exato.

### Tentativa barrada não é cobrada

Se a requisição for recusada por filtro de segurança, **não entra na fatura**.
Vale saber antes de passar a tarde com medo de testar.

### Ele não entrega enquadramento

Pedir "close no rosto" ou "plano aberto" funciona *às vezes*. Para material que
depende de enquadramento específico, conte com **duas tomadas** e escolha — sai
mais barato que dez tentativas ajustando o prompt.

### A voz nunca sai do Veo

O áudio nativo do Veo serve para ambiente e ruído. **Fala com voz definida é
TTS separado**, gerado depois e sincronizado — é para isso que existem os outros
dois scripts aqui.

### O vídeo some do servidor em ~2 dias

O link retornado pela operação expira. O `veo-animate.mjs` já baixa o MP4 assim
que a operação termina, por isso.

## Sobre a voz

O Gemini TTS tem **30 vozes nomeadas e determinísticas** — a mesma voz com o
mesmo texto sai igual, o que permite regerar uma frase sem que a peça inteira
mude de timbre.

Duas coisas que valem mais que a tabela de adjetivos da documentação:

- **Escolha por audição.** Os rótulos ("Bright", "Firm") descrevem mal o
  resultado em português.
- **Reserve a voz do seu personagem recorrente.** Duas personagens com o mesmo
  timbre destroem, no áudio, a consistência que as reference images constroem na
  imagem — e isso passa despercebido peça a peça, só aparece quando alguém
  assiste a duas seguidas.

O TTS devolve **PCM 24 kHz**, não WAV. O `tts-voz.mjs` escreve o cabeçalho RIFF
na mão, porque nenhum player abre o PCM cru.

## Sincronizar voz e vídeo

O `juntar-voz.mjs` usa **ffmpeg** (precisa estar no PATH). Quando a narração é
um pouco mais longa que o vídeo, ele acelera o áudio — **até 1,15×**.

Esse teto não é arbitrário: acima disso a fala fica perceptivelmente apressada.
A conta de quanto texto cabe em 8 segundos sai de **2,35 palavras por segundo**,
medido em oito amostras reais das vozes — não é a estimativa genérica de
locução, que é mais lenta.

## Licença

MIT. Veja [LICENSE](LICENSE).
