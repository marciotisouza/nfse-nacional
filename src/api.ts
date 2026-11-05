import * as https from 'https'
import { gzipSync, gunzipSync } from 'zlib'
import axios, { type AxiosResponse } from 'axios'
import { extrairPemTls } from './certificate.js'

/**
 * Cliente HTTP da API da NFS-e Nacional (Sefin Nacional + ADN), com mTLS pelo certificado A1.
 * Referência: https://www.nfse.gov.br/swagger/contribuintesissqn/
 */

export type Ambiente = 1 | 2

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

function montarRetorno(resp: AxiosResponse<any>, campoXml: string): RetornoNacional {
  const data = resp.data
  const b64 = data?.[campoXml]
  const ok = resp.status >= 200 && resp.status < 300
  const erros = ok ? [] : extrairErros(data)
  if (!ok && erros.length === 0) erros.push({ codigo: String(resp.status), descricao: `HTTP ${resp.status} da API nacional.` })
  return {
    status: resp.status,
    chaveAcesso: data?.chaveAcesso ?? null,
    xml: ok && typeof b64 === 'string' ? gunzipB64(b64) : null,
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
  const resp = await axios.post(`${URLS[c.ambiente].sefin}/nfse`, { dpsXmlGZipB64: gzipB64(dpsXmlAssinado) }, opcoes(c))
  return montarRetorno(resp, 'nfseXmlGZipB64')
}

/** GET /nfse/{chave} — XML da NFS-e. */
export async function consultarNfse(c: ConexaoNacional, chaveAcesso: string): Promise<RetornoNacional> {
  const resp = await axios.get(`${URLS[c.ambiente].sefin}/nfse/${chaveAcesso}`, opcoes(c))
  return montarRetorno(resp, 'nfseXmlGZipB64')
}

/** GET /dps/{id} — chave da NFS-e gerada a partir da DPS (recuperação de reenvio), ou null. */
export async function consultarChavePorDps(c: ConexaoNacional, idDps: string): Promise<string | null> {
  const resp = await axios.get(`${URLS[c.ambiente].sefin}/dps/${idDps}`, opcoes(c))
  return resp.status === 200 ? (resp.data?.chaveAcesso ?? null) : null
}

/** POST /nfse/{chave}/eventos — registra evento (ex.: cancelamento e101101). */
export async function enviarEvento(c: ConexaoNacional, chaveAcesso: string, pedidoXmlAssinado: string): Promise<RetornoNacional> {
  const resp = await axios.post(
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
  const resp = await axios.get(`${URLS[c.ambiente].sefin}/nfse/${chaveAcesso}/eventos/${tipoEvento}/${sequencial}`, opcoes(c))
  return montarRetorno(resp, 'eventoXmlGZipB64')
}

/** GET {adn}/danfse/{chave} — PDF oficial do DANFSe. Retorna null se o ADN não entregar PDF (comum). */
export async function baixarDanfse(c: ConexaoNacional, chaveAcesso: string): Promise<Buffer | null> {
  try {
    const resp = await axios.get(`${URLS[c.ambiente].adn}/danfse/${chaveAcesso}`, {
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
