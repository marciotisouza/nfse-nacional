import { SignedXml } from 'xml-crypto'

/**
 * Montagem e assinatura dos XMLs da NFS-e Nacional (DPS leiaute 1.01).
 * Estrutura validada em produção (11/2026) para prestador do Simples Nacional (ME/EPP).
 */

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const VERSAO = '1.01'

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const SHA1_DIGEST = 'http://www.w3.org/2000/09/xmldsig#sha1'
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'

const TROCAS: Record<string, string> = {
  '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', ' ': ' ',
}

/** Os tipos string do XSD só aceitam Latin-1 (até ÿ); troca tipografia comum e descarta o resto. */
export function latin1(texto: string): string {
  return texto.replace(/[^\n\x20-\xFF]/g, (c) => TROCAS[c] ?? '')
}

function esc(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Campo de uma linha: Latin-1, sem quebras/espaços duplicados, truncado ao limite do XSD. */
function linha(texto: string | null | undefined, max: number): string {
  return esc(latin1(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim())
}

const digitos = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '')
const dec = (v: number) => v.toFixed(2)

/** Data/hora no fuso de Brasília (-03:00, sem horário de verão), formato TSDateTimeUTC. */
export function dataHoraBrasilia(d: Date = new Date()): string {
  return new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 19) + '-03:00'
}

/** Data de hoje em Brasília (AAAA-MM-DD). */
export function hojeBrasilia(): string {
  return dataHoraBrasilia().slice(0, 10)
}

/**
 * Id da DPS: "DPS" + cMun(7) + tpInsc(1: 2=CNPJ) + CNPJ(14) + série(5) + nDPS(15).
 * O par série + nDPS é a chave de idempotência na Sefin (reenvio = E0014).
 */
export function montarIdDps(codMunicipioEmissor: string, cnpjPrestador: string, serie: string, nDps: string | number): string {
  return `DPS${digitos(codMunicipioEmissor).padStart(7, '0')}2${digitos(cnpjPrestador).padStart(14, '0')}${String(serie).padStart(5, '0')}${String(nDps).padStart(15, '0')}`
}

export interface Endereco {
  /** Código IBGE do município (7 dígitos). */
  codMunicipio: string
  cep: string
  logradouro: string
  numero?: string | null
  complemento?: string | null
  bairro: string
}

export interface DadosDps {
  /** 1 = produção, 2 = produção restrita. */
  ambiente: 1 | 2
  /**
   * Leiaute NT-009: inclui `<finNFSe>0</finNFSe>` e põe `<cNBS>` antes de `<xDescServ>`.
   * A produção restrita já exige; a produção (11/2026) ainda rejeita. Padrão: true só se ambiente = 2.
   */
  leiauteNt009?: boolean
  /** Identificação do aplicativo emissor (verAplic, até 20 caracteres). */
  verAplic?: string

  /** Série da DPS (1 a 5 dígitos). Use uma série exclusiva por sistema emissor do mesmo CNPJ. */
  serie: string
  /** Número da DPS (1 a 15 dígitos), único dentro da série. */
  nDps: string | number
  /** Competência AAAA-MM-DD (não pode ser futura). */
  competencia: string
  /** Data/hora de emissão. Padrão: agora − 60 s (a Sefin rejeita dhEmi à frente do relógio dela). */
  dhEmi?: Date

  prestador: {
    cnpj: string
    /** Código IBGE do município emissor (cLocEmi; também entra no Id da DPS). */
    codMunicipio: string
    /** Inscrição municipal — opcional (o padrão nacional dispensa para SP). */
    inscricaoMunicipal?: string | null
    /** 1 = não optante, 2 = MEI, 3 = ME/EPP. Padrão 3. */
    opSimpNac?: 1 | 2 | 3
    /** Só para opSimpNac = 3. 1 = tributos federais e municipal pelo SN. Padrão 1. */
    regApTribSN?: 1 | 2 | 3
    /** Regime especial de tributação (0 = nenhum). Padrão 0. */
    regEspTrib?: 0 | 1 | 2 | 3 | 4 | 5 | 6
  }

  tomador?: {
    cnpj?: string | null
    cpf?: string | null
    nome: string
    inscricaoMunicipal?: string | null
    /** Só vai no XML se completo (codMunicipio, CEP com 8 dígitos, logradouro e bairro). */
    endereco?: Partial<Endereco> | null
    fone?: string | null
    email?: string | null
  } | null

  servico: {
    /** Município da prestação (IBGE). Padrão: o do prestador. */
    codMunicipioPrestacao?: string
    /** Código de tributação nacional (6 dígitos, ex.: 010101). */
    codTribNacional: string
    /** Código de tributação municipal (3 dígitos, ex.: 001). */
    codTribMunicipal?: string | null
    /** Código NBS (9 dígitos, ex.: 115022000). */
    codNbs?: string | null
    /** Discriminação (até 2000 caracteres, aceita quebras de linha). */
    descricao: string
  }

  valores: {
    /** Valor do serviço. */
    valor: number
    /** 1 = tributável, 2 = imunidade, 3 = exportação, 4 = não incidência. Padrão 1. */
    tribISSQN?: 1 | 2 | 3 | 4
    /** 1 = não retido, 2 = retido pelo tomador, 3 = retido pelo intermediário. Padrão 1. */
    tpRetISSQN?: 1 | 2 | 3
    /** PIS/COFINS. Padrão: CST 00, valores 0, não retidos. `null` omite o grupo. */
    pisCofins?: { cst: string; vPis?: number; vCofins?: number; tpRet?: 0 | 1 | 2 } | null
    /** Valores aproximados dos tributos (Lei 12.741). Padrão: todos 0. */
    totTrib?: { federal?: number; estadual?: number; municipal?: number }
  }
}

function montarEndereco(e: Partial<Endereco> | null | undefined): string {
  if (!e) return ''
  const cep = digitos(e.cep)
  if (!(e.codMunicipio && cep.length === 8 && e.logradouro?.trim() && e.bairro?.trim())) return ''
  return (
    '<end>' +
    `<endNac><cMun>${digitos(e.codMunicipio)}</cMun><CEP>${cep}</CEP></endNac>` +
    `<xLgr>${linha(e.logradouro, 255)}</xLgr>` +
    `<nro>${linha(e.numero, 60) || 'S/N'}</nro>` +
    (e.complemento?.trim() ? `<xCpl>${linha(e.complemento, 156)}</xCpl>` : '') +
    `<xBairro>${linha(e.bairro, 60)}</xBairro>` +
    '</end>'
  )
}

function montarTomador(t: DadosDps['tomador']): string {
  if (!t) return ''
  const cnpj = digitos(t.cnpj)
  const doc = cnpj.length === 14 ? `<CNPJ>${cnpj}</CNPJ>` : `<CPF>${digitos(t.cpf)}</CPF>`
  const fone = digitos(t.fone)
  return (
    '<toma>' +
    doc +
    (t.inscricaoMunicipal?.trim() ? `<IM>${linha(t.inscricaoMunicipal, 15)}</IM>` : '') +
    `<xNome>${linha(t.nome, 300)}</xNome>` +
    montarEndereco(t.endereco) +
    (fone.length >= 6 && fone.length <= 20 ? `<fone>${fone}</fone>` : '') +
    (t.email?.trim() ? `<email>${linha(t.email, 80)}</email>` : '') +
    '</toma>'
  )
}

/** XML da DPS sem assinatura (assine com `assinarXml(xml, 'infDPS', ...)`). */
export function montarXmlDps(d: DadosDps): string {
  const p = d.prestador
  const s = d.servico
  const v = d.valores
  const nt009 = d.leiauteNt009 ?? d.ambiente === 2
  const opSimpNac = p.opSimpNac ?? 3
  const cMunEmi = digitos(p.codMunicipio)
  const id = montarIdDps(cMunEmi, p.cnpj, d.serie, d.nDps)
  const descricao = esc(latin1(s.descricao).replace(/\r\n?/g, '\n').trim().slice(0, 2000).trim())
  const descNbs = s.codNbs
    ? nt009
      ? `<cNBS>${digitos(s.codNbs)}</cNBS><xDescServ>${descricao}</xDescServ>`
      : `<xDescServ>${descricao}</xDescServ><cNBS>${digitos(s.codNbs)}</cNBS>`
    : `<xDescServ>${descricao}</xDescServ>`
  const pc = v.pisCofins === undefined ? { cst: '00', vPis: 0, vCofins: 0, tpRet: 0 as const } : v.pisCofins
  const tt = v.totTrib ?? {}

  return (
    `<DPS xmlns="${NS}" versao="${VERSAO}">` +
    `<infDPS Id="${id}">` +
    `<tpAmb>${d.ambiente}</tpAmb>` +
    `<dhEmi>${dataHoraBrasilia(d.dhEmi ?? new Date(Date.now() - 60_000))}</dhEmi>` +
    `<verAplic>${linha(d.verAplic ?? 'nfse-nacional', 20)}</verAplic>` +
    `<serie>${d.serie}</serie>` +
    `<nDPS>${String(d.nDps).replace(/^0+/, '')}</nDPS>` +
    `<dCompet>${d.competencia}</dCompet>` +
    '<tpEmit>1</tpEmit>' +
    (nt009 ? '<finNFSe>0</finNFSe>' : '') +
    `<cLocEmi>${cMunEmi}</cLocEmi>` +
    '<prest>' +
    `<CNPJ>${digitos(p.cnpj)}</CNPJ>` +
    (p.inscricaoMunicipal?.trim() ? `<IM>${linha(p.inscricaoMunicipal, 15)}</IM>` : '') +
    '<regTrib>' +
    `<opSimpNac>${opSimpNac}</opSimpNac>` +
    (opSimpNac === 3 ? `<regApTribSN>${p.regApTribSN ?? 1}</regApTribSN>` : '') +
    `<regEspTrib>${p.regEspTrib ?? 0}</regEspTrib>` +
    '</regTrib>' +
    '</prest>' +
    montarTomador(d.tomador) +
    '<serv>' +
    `<locPrest><cLocPrestacao>${digitos(s.codMunicipioPrestacao ?? cMunEmi)}</cLocPrestacao></locPrest>` +
    '<cServ>' +
    `<cTribNac>${digitos(s.codTribNacional)}</cTribNac>` +
    (s.codTribMunicipal ? `<cTribMun>${s.codTribMunicipal}</cTribMun>` : '') +
    descNbs +
    '</cServ>' +
    '</serv>' +
    '<valores>' +
    `<vServPrest><vServ>${dec(v.valor)}</vServ></vServPrest>` +
    '<trib>' +
    `<tribMun><tribISSQN>${v.tribISSQN ?? 1}</tribISSQN><tpRetISSQN>${v.tpRetISSQN ?? 1}</tpRetISSQN></tribMun>` +
    (pc
      ? '<tribFed><piscofins>' +
        `<CST>${pc.cst}</CST>` +
        (pc.vPis != null ? `<vPis>${pc.vPis ? dec(pc.vPis) : 0}</vPis>` : '') +
        (pc.vCofins != null ? `<vCofins>${pc.vCofins ? dec(pc.vCofins) : 0}</vCofins>` : '') +
        `<tpRetPisCofins>${pc.tpRet ?? 0}</tpRetPisCofins>` +
        '</piscofins></tribFed>'
      : '') +
    '<totTrib><vTotTrib>' +
    `<vTotTribFed>${tt.federal ? dec(tt.federal) : 0}</vTotTribFed>` +
    `<vTotTribEst>${tt.estadual ? dec(tt.estadual) : 0}</vTotTribEst>` +
    `<vTotTribMun>${tt.municipal ? dec(tt.municipal) : 0}</vTotTribMun>` +
    '</vTotTrib></totTrib>' +
    '</trib>' +
    '</valores>' +
    '</infDPS>' +
    '</DPS>'
  )
}

/** 1 = erro na emissão, 2 = serviço não prestado, 9 = outros. */
export type MotivoCancelamento = 1 | 2 | 9

/** Pedido de registro do evento de cancelamento (e101101), sem assinatura (assine `infPedReg`). */
export function montarXmlCancelamento(opts: {
  ambiente: 1 | 2
  cnpjPrestador: string
  chaveAcesso: string
  motivo: MotivoCancelamento
  /** 15 a 255 caracteres. */
  justificativa: string
  verAplic?: string
}): string {
  const id = `PRE${opts.chaveAcesso}101101`
  return (
    `<pedRegEvento xmlns="${NS}" versao="${VERSAO}">` +
    `<infPedReg Id="${id}">` +
    `<tpAmb>${opts.ambiente}</tpAmb>` +
    `<verAplic>${linha(opts.verAplic ?? 'nfse-nacional', 20)}</verAplic>` +
    `<dhEvento>${dataHoraBrasilia(new Date(Date.now() - 60_000))}</dhEvento>` +
    `<CNPJAutor>${digitos(opts.cnpjPrestador)}</CNPJAutor>` +
    `<chNFSe>${opts.chaveAcesso}</chNFSe>` +
    '<e101101>' +
    '<xDesc>Cancelamento de NFS-e</xDesc>' +
    `<cMotivo>${opts.motivo}</cMotivo>` +
    `<xMotivo>${linha(opts.justificativa, 255)}</xMotivo>` +
    '</e101101>' +
    '</infPedReg>' +
    '</pedRegEvento>'
  )
}

/**
 * Assina o elemento `tagAssinada` (infDPS / infPedReg) por referência ao atributo Id,
 * XMLDSig RSA-SHA1 envelopado com C14N; a Signature fica logo após o elemento assinado.
 */
export function assinarXml(xml: string, tagAssinada: string, privateKeyPem: string, certBase64: string): string {
  const xpath = `//*[local-name(.)='${tagAssinada}']`
  const sig = new SignedXml({
    privateKey: Buffer.from(privateKeyPem),
    publicCert: Buffer.from(`-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----`),
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: RSA_SHA1,
  })
  sig.addReference({ xpath, transforms: [ENVELOPED, C14N], digestAlgorithm: SHA1_DIGEST })
  sig.computeSignature(xml, { location: { reference: xpath, action: 'after' } })
  return sig.getSignedXml()
}

/** Número da NFS-e (`<nNFSe>`) no XML retornado pela Sefin. */
export function extrairNumeroNfse(xmlNfse: string | null | undefined): string | null {
  return xmlNfse?.match(/<nNFSe>(\d+)<\/nNFSe>/)?.[1] ?? null
}
