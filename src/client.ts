import * as api from './api.js'
import { extrairDadosCertificado, verificarCertificado, type InfoCertificado } from './certificate.js'
import { gerarDanfsePdf, type OpcoesPdf } from './danfse.js'
import {
  assinarXml,
  extrairNumeroNfse,
  montarIdDps,
  montarXmlCancelamento,
  montarXmlDps,
  type DadosDps,
  type MotivoCancelamento,
} from './dps.js'

export interface NfseNacionalConfig {
  /** Buffer do certificado A1 (.pfx/.p12) do prestador. */
  pfxBuf: Buffer
  /** Senha do certificado. */
  pfxSenha: string
  /** CNPJ do prestador (14 dígitos). */
  cnpjPrestador: string
  /** Código IBGE do município do prestador (ex.: 3550308 = São Paulo). */
  codMunicipio: string
  /** 1 = produção, 2 = produção restrita (homologação). */
  ambiente: 1 | 2
  /** Leiaute NT-009 (ver `DadosDps.leiauteNt009`). Padrão: true só na produção restrita. */
  leiauteNt009?: boolean
  /** verAplic gravado na DPS/eventos (até 20 caracteres). */
  verAplic?: string
  /** Timeout por requisição (ms). Padrão 40 000. */
  timeoutMs?: number
}

/** Dados de uma emissão — o cliente completa ambiente, prestador e leiaute a partir da config. */
export type DadosEmissao = Omit<DadosDps, 'ambiente' | 'leiauteNt009' | 'verAplic' | 'prestador'> & {
  prestador?: Partial<DadosDps['prestador']>
}

export interface RetornoEmissao {
  sucesso: boolean
  erros: api.ErroNacional[]
  /** Id da DPS (identifica a emissão na Sefin; use para recuperar). */
  idDps: string
  chaveAcesso: string | null
  /** Número da NFS-e (`nNFSe`). */
  numero: string | null
  /** XML da NFS-e autorizada. */
  xml: string | null
  /** true quando a nota já existia (reenvio/timeout) e foi recuperada pela DPS, sem duplicar. */
  recuperada: boolean
  /** DPS assinada que foi (ou seria, no modo teste) enviada. */
  xmlDps: string
}

/**
 * Cliente da NFS-e Nacional (Sefin Nacional / ADN).
 *
 * ```ts
 * const nfse = new NfseNacionalClient({
 *   pfxBuf: Buffer.from(process.env.CERT_BASE64!, 'base64'),
 *   pfxSenha: process.env.CERT_SENHA!,
 *   cnpjPrestador: '00000000000000',
 *   codMunicipio: '3550308',
 *   ambiente: 2,
 * })
 * const r = await nfse.emitir({ serie: '3', nDps: 123, competencia: '2026-11-05', tomador, servico, valores })
 * ```
 *
 * Idempotência: grave (serie, nDps) ANTES de chamar `emitir` e reutilize o mesmo número em
 * reenvios. Se a Sefin já tiver gerado a nota (timeout, E0014), `emitir` a recupera.
 */
export class NfseNacionalClient {
  private readonly conexao: api.ConexaoNacional

  constructor(private readonly config: NfseNacionalConfig) {
    this.conexao = {
      ambiente: config.ambiente,
      pfxBuf: config.pfxBuf,
      pfxSenha: config.pfxSenha,
      timeoutMs: config.timeoutMs,
    }
  }

  private assinar(xml: string, tag: string): string {
    const { privateKeyPem, certBase64 } = extrairDadosCertificado(this.config.pfxBuf, this.config.pfxSenha)
    return assinarXml(xml, tag, privateKeyPem, certBase64)
  }

  /** Id da DPS para (série, nDPS) deste prestador. */
  idDps(serie: string, nDps: string | number): string {
    return montarIdDps(this.config.codMunicipio, this.config.cnpjPrestador, serie, nDps)
  }

  /** Monta e assina a DPS, sem enviar. */
  montarDps(dados: DadosEmissao): string {
    const completo: DadosDps = {
      ...dados,
      ambiente: this.config.ambiente,
      leiauteNt009: this.config.leiauteNt009,
      verAplic: this.config.verAplic,
      prestador: {
        ...dados.prestador,
        cnpj: this.config.cnpjPrestador,
        codMunicipio: this.config.codMunicipio,
      },
    }
    return this.assinar(montarXmlDps(completo), 'infDPS')
  }

  /**
   * Emite a NFS-e (síncrono). Se o envio falhar sem resposta ou com DPS duplicada, consulta a
   * DPS e devolve a nota já existente (`recuperada: true`).
   *
   * @param opcoes.teste  Só monta e assina; não envia.
   */
  async emitir(dados: DadosEmissao, opcoes: { teste?: boolean } = {}): Promise<RetornoEmissao> {
    const idDps = this.idDps(dados.serie, dados.nDps)
    const xmlDps = this.montarDps(dados)
    const base = { idDps, xmlDps, chaveAcesso: null, numero: null, xml: null, recuperada: false }
    if (opcoes.teste) return { ...base, sucesso: true, erros: [] }

    let retorno: api.RetornoNacional
    try {
      retorno = await api.enviarDps(this.conexao, xmlDps)
    } catch (e: any) {
      retorno = {
        status: 0,
        chaveAcesso: null,
        xml: null,
        erros: [{ codigo: null, descricao: `Sefin não respondeu (${e?.message ?? e}). Reenvie com a mesma série/nDPS: se a nota tiver sido gerada, ela é recuperada sem duplicar.` }],
      }
    }

    let recuperada = false
    if (!retorno.chaveAcesso || !retorno.xml) {
      const chave = await api.consultarChavePorDps(this.conexao, idDps).catch(() => null)
      if (chave) {
        const consulta = await api.consultarNfse(this.conexao, chave).catch(() => null)
        if (consulta?.xml) {
          retorno = { ...consulta, chaveAcesso: chave, erros: [] }
          recuperada = true
        }
      }
    }

    if (!retorno.chaveAcesso || !retorno.xml) return { ...base, sucesso: false, erros: retorno.erros }
    return {
      ...base,
      sucesso: true,
      erros: [],
      chaveAcesso: retorno.chaveAcesso,
      numero: extrairNumeroNfse(retorno.xml),
      xml: retorno.xml,
      recuperada,
    }
  }

  /** XML da NFS-e pela chave de acesso. */
  async consultar(chaveAcesso: string): Promise<api.RetornoNacional & { numero: string | null }> {
    const r = await api.consultarNfse(this.conexao, chaveAcesso)
    return { ...r, numero: extrairNumeroNfse(r.xml) }
  }

  /** Chave de acesso da NFS-e gerada por uma DPS (null se a DPS não foi processada). */
  async chavePorDps(serie: string, nDps: string | number): Promise<string | null> {
    return api.consultarChavePorDps(this.conexao, this.idDps(serie, nDps))
  }

  /**
   * Cancela a NFS-e (evento e101101). Depois de cancelar, uma reemissão precisa de OUTRO nDPS
   * (a DPS antiga continua processada).
   *
   * @param motivo  1 = erro na emissão, 2 = serviço não prestado, 9 = outros
   * @param justificativa  15 a 255 caracteres
   */
  async cancelar(
    chaveAcesso: string,
    motivo: MotivoCancelamento = 1,
    justificativa = 'Erro na emissao da nota fiscal de servico',
  ): Promise<{ sucesso: boolean; erros: api.ErroNacional[]; xmlEvento: string | null }> {
    if (justificativa.trim().length < 15) throw new Error('Justificativa deve ter ao menos 15 caracteres.')
    const xml = this.assinar(
      montarXmlCancelamento({
        ambiente: this.config.ambiente,
        cnpjPrestador: this.config.cnpjPrestador,
        chaveAcesso,
        motivo,
        justificativa,
        verAplic: this.config.verAplic,
      }),
      'infPedReg',
    )
    const r = await api.enviarEvento(this.conexao, chaveAcesso, xml)
    return { sucesso: r.erros.length === 0, erros: r.erros, xmlEvento: r.xml }
  }

  /** XML do evento de cancelamento (confirma que a nota está cancelada). */
  async consultarCancelamento(chaveAcesso: string): Promise<api.RetornoNacional> {
    return api.consultarEvento(this.conexao, chaveAcesso, '101101', 1)
  }

  /**
   * PDF do DANFSe: tenta o oficial do ADN; se indisponível, gera localmente a partir do XML
   * (requer `puppeteer` instalado). Informe o XML para evitar uma consulta extra.
   */
  async danfse(chaveAcesso: string, xmlNfse?: string | null, opcoes: OpcoesPdf & { somenteLocal?: boolean } = {}): Promise<{ pdf: Buffer; oficial: boolean }> {
    if (!opcoes.somenteLocal) {
      const oficial = await api.baixarDanfse(this.conexao, chaveAcesso)
      if (oficial) return { pdf: oficial, oficial: true }
    }
    const xml = xmlNfse ?? (await api.consultarNfse(this.conexao, chaveAcesso)).xml
    if (!xml) throw new Error('XML da NFS-e não disponível para gerar o DANFSe.')
    return { pdf: await gerarDanfsePdf(xml, opcoes), oficial: false }
  }

  /**
   * Distribuição de DF-e pelo ADN: até 50 NFS-e/eventos com NSU > `ultimoNsu` em que o CNPJ do
   * certificado é parte (prestador, tomador ou intermediário). Guarde `ultimoNsu` do retorno por
   * CNPJ e chame de novo enquanto `haMais`. Comece com 0 para baixar tudo.
   *
   * @param cnpjConsulta  Padrão: `cnpjPrestador` da config.
   */
  async distribuicaoDfe(ultimoNsu = 0, cnpjConsulta?: string): Promise<api.RetornoDistribuicao> {
    return api.distribuicaoDfe(this.conexao, ultimoNsu, cnpjConsulta ?? this.config.cnpjPrestador)
  }

  /**
   * Dados e validade do certificado A1 configurado, e se o CNPJ dele confere com `cnpjPrestador`.
   * Útil num health-check: `if (info.expirado || info.vencendo || !info.cnpjConfere) avisar()`.
   */
  certificado(opcoes: { diasAviso?: number } = {}): InfoCertificado & { cnpjConfere: boolean } {
    const info = verificarCertificado(this.config.pfxBuf, this.config.pfxSenha, opcoes)
    return { ...info, cnpjConfere: info.cnpj === this.config.cnpjPrestador.replace(/\D/g, '') }
  }
}
