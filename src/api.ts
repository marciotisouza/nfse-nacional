import * as https from 'https'
import { gzipSync, gunzipSync } from 'zlib'
import axios, { type AxiosResponse } from 'axios'
import { extrairPemTls } from './certificate.js'

/**
 * Cliente HTTP da API da NFS-e Nacional (Sefin Nacional + ADN), com mTLS pelo certificado A1.
 * Referência: https://www.nfse.gov.br/swagger/contribuintesissqn/
 */

export type Ambiente = 1 | 2

/**
 * Instância axios que troca o AxiosError por um Error simples: o original carrega `config.httpsAgent`
 * com a chave privada do certificado, que vazaria em qualquer log do erro.
 */
const http = axios.create()
http.interceptors.response.use(undefined, (e: any) => {
  const erro = new Error(`Falha na comunicação com a API nacional: ${e?.message ?? e}`) as Error & { code?: string }
  if (e?.code) erro.code = e.code
  return Promise.reject(erro)
})

export const URLS: Record<Ambiente, { sefin: string; adn: string }> = {
  1: { sefin: 'https://sefin.nfse.gov.br/SefinNacional', adn: 'https://adn.nfse.gov.br' },
  2: {
    sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adn: 'https://adn.producaorestrita.nfse.gov.br',
  },
}

export interface ErroNacional {
  codigo: string | null
  descricao: string | null
}

export interface RetornoNacional {
  /** Status HTTP (0 = sem resposta: timeout/queda de conexão). */
  status: number
  chaveAcesso: string | null
  /** XML da NFS-e (ou do evento) já descompactado. */
  xml: string | null
  erros: ErroNacional[]
}

export interface ConexaoNacional {
  ambiente: Ambiente
  pfxBuf: Buffer
  pfxSenha: string
  /**
   * Timeout por requisição, em ms (padrão 40 000). A Sefin às vezes passa de 60 s e gera a nota
   * mesmo assim — mantenha abaixo do timeout do seu proxy para dar tempo da recuperação.
   */
  timeoutMs?: number
}

// A Sefin rejeita sem a declaração de encoding (E1229 "Xml não está utilizando codificação UTF-8").
const DECLARACAO = '<?xml version="1.0" encoding="UTF-8"?>'

/** GZip + Base64 do XML (com a declaração UTF-8 obrigatória). */
export const gzipB64 = (xml: string) =>
  gzipSync(Buffer.from(xml.startsWith('<?xml') ? xml : DECLARACAO + xml, 'utf-8')).toString('base64')
export const gunzipB64 = (b64: string) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf-8')

/** A API devolve erros ora em `erros`, ora em `erro`, com chaves em maiúscula ou minúscula. */
export function extrairErros(data: any): ErroNacional[] {
  if (!data || typeof data !== 'object') {
    return typeof data === 'string' && data.trim() ? [{ codigo: null, descricao: data.trim().slice(0, 500) }] : []
  }
  const lista = data.erros ?? data.Erros ?? data.erro ?? data.Erro
  const arr = Array.isArray(lista) ? lista : lista ? [lista] : []
  return arr.map((e: any) => ({
    codigo: e?.codigo ?? e?.Codigo ?? null,
    descricao: [e?.descricao ?? e?.Descricao, e?.complemento ?? e?.Complemento].filter(Boolean).join(' — ') || null,
  }))
}

/**
 * Decodifica o XML devolvido pela Sefin: Base64 de gzip, Base64 puro, ou Base64 de um texto que é
 * outro Base64 de gzip (caso do `arquivoXml` do GET de eventos).
 */
function decodificarXml(b64: string, profundidade = 0): string {
  const buf = Buffer.from(b64, 'base64')
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf-8')
  const texto = buf.toString('utf-8')
  return profundidade < 2 && texto.startsWith('H4sI') ? decodificarXml(texto, profundidade + 1) : texto
}

function montarRetorno(resp: AxiosResponse<any>, campoXml: string): RetornoNacional {
  const data = resp.data
  // GET .../eventos devolve { eventos: [{ arquivoXml }] }; o POST devolve eventoXmlGZipB64.
  const b64 = data?.[campoXml] ?? data?.eventos?.[0]?.arquivoXml
  const ok = resp.status >= 200 && resp.status < 300
  const erros = ok ? [] : extrairErros(data)
  if (!ok && erros.length === 0) erros.push({ codigo: String(resp.status), descricao: `HTTP ${resp.status} da API nacional.` })
  return {
    status: resp.status,
    chaveAcesso: data?.chaveAcesso ?? null,
    xml: ok && typeof b64 === 'string' ? decodificarXml(b64) : null,
    erros,
  }
}

function opcoes(c: ConexaoNacional) {
  return {
    // rejectUnauthorized:false — a cadeia ICP-Brasil/SERPRO não está no bundle de CAs do Node.
    httpsAgent: new https.Agent({ ...extrairPemTls(c.pfxBuf, c.pfxSenha), rejectUnauthorized: false }),
    timeout: c.timeoutMs ?? 40_000,
    validateStatus: () => true,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  }
}

/** POST /nfse — envia a DPS assinada; emissão síncrona (201 com a NFS-e autorizada). */
export async function enviarDps(c: ConexaoNacional, dpsXmlAssinado: string): Promise<RetornoNacional> {
  const resp = await http.post(`${URLS[c.ambiente].sefin}/nfse`, { dpsXmlGZipB64: gzipB64(dpsXmlAssinado) }, opcoes(c))
  return montarRetorno(resp, 'nfseXmlGZipB64')
}

/** GET /nfse/{chave} — XML da NFS-e. */
export async function consultarNfse(c: ConexaoNacional, chaveAcesso: string): Promise<RetornoNacional> {
  const resp = await http.get(`${URLS[c.ambiente].sefin}/nfse/${chaveAcesso}`, opcoes(c))
  return montarRetorno(resp, 'nfseXmlGZipB64')
}

/** GET /dps/{id} — chave da NFS-e gerada a partir da DPS (recuperação de reenvio), ou null. */
export async function consultarChavePorDps(c: ConexaoNacional, idDps: string): Promise<string | null> {
  const resp = await http.get(`${URLS[c.ambiente].sefin}/dps/${idDps}`, opcoes(c))
  return resp.status === 200 ? (resp.data?.chaveAcesso ?? null) : null
}

/** POST /nfse/{chave}/eventos — registra evento (ex.: cancelamento e101101). */
export async function enviarEvento(c: ConexaoNacional, chaveAcesso: string, pedidoXmlAssinado: string): Promise<RetornoNacional> {
  const resp = await http.post(
    `${URLS[c.ambiente].sefin}/nfse/${chaveAcesso}/eventos`,
    { pedidoRegistroEventoXmlGZipB64: gzipB64(pedidoXmlAssinado) },
    opcoes(c),
  )
  return montarRetorno(resp, 'eventoXmlGZipB64')
}

/** GET /nfse/{chave}/eventos/{tipo}/{seq} — XML de um evento (ex.: 101101/1 = cancelamento). */
export async function consultarEvento(
  c: ConexaoNacional,
  chaveAcesso: string,
  tipoEvento = '101101',
  sequencial = 1,
): Promise<RetornoNacional> {
  const resp = await http.get(`${URLS[c.ambiente].sefin}/nfse/${chaveAcesso}/eventos/${tipoEvento}/${sequencial}`, opcoes(c))
  return montarRetorno(resp, 'eventoXmlGZipB64')
}

/** GET {adn}/danfse/{chave} — PDF oficial do DANFSe. Retorna null se o ADN não entregar PDF (comum). */
export async function baixarDanfse(c: ConexaoNacional, chaveAcesso: string): Promise<Buffer | null> {
  try {
    const resp = await http.get(`${URLS[c.ambiente].adn}/danfse/${chaveAcesso}`, {
      ...opcoes(c),
      timeout: 30_000,
      responseType: 'arraybuffer',
      headers: { Accept: 'application/pdf' },
    })
    const buf = Buffer.from(resp.data)
    return resp.status === 200 && buf.subarray(0, 4).toString() === '%PDF' ? buf : null
  } catch {
    return null
  }
}
