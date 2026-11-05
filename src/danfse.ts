import fs from 'fs'
import * as https from 'https'
import axios from 'axios'
import { XMLParser } from 'fast-xml-parser'
import QRCode from 'qrcode'
import { LOGO_NFSE_PNG_BASE64 } from './logo.js'

/**
 * DANFSe gerado localmente a partir do XML da NFS-e Nacional, reproduzindo o leiaute do
 * DANFSe v2.0 do portal nacional (NT 008 SE/CGNFS-e): mesmas seções, campos e QR Code de
 * consulta pública. Use quando o ADN (adn.nfse.gov.br/danfse) não entrega o PDF oficial — o que
 * é frequente.
 */

const URL_CONSULTA = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave='

/** UF pelos 2 primeiros dígitos do código IBGE do município. */
const UF_POR_CODIGO: Record<string, string> = {
  '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI',
  '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES',
  '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
}

const _municipios = new Map<string, string>()

async function nomeMunicipioIbge(cMun: string): Promise<string> {
  if (!cMun) return ''
  if (_municipios.has(cMun)) return _municipios.get(cMun)!
  try {
    const resp = await axios.get(`https://servicodados.ibge.gov.br/api/v1/localidades/municipios/${cMun}`, {
      timeout: 5000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    })
    const nome = String(resp.data?.nome ?? '')
    if (nome) _municipios.set(cMun, nome)
    return nome
  } catch {
    return ''
  }
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const brl = (v: unknown) =>
  'R$ ' + Number(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Percentual pt-BR (`18,05%`); '-' se ausente. */
const pct = (v: unknown) =>
  v == null || v === '' ? '-' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'

function fmtDoc(d: unknown): string {
  const s = String(d ?? '')
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  return s || '-'
}

function fmtFone(f: unknown): string {
  const s = String(f ?? '').replace(/\D/g, '')
  if (s.length === 10) return s.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3')
  if (s.length === 11) return s.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3')
  return s || '-'
}

const fmtCep = (c: unknown) => {
  const s = String(c ?? '').replace(/\D/g, '')
  return s ? s.padStart(8, '0').replace(/^(\d{5})(\d{3})$/, '$1-$2') : '-'
}

function fmtDataHora(iso: unknown, comHora: boolean): string {
  const s = String(iso ?? '')
  if (!s) return '-'
  const [d, t] = s.split('T')
  const [a, m, dia] = d.split('-')
  return `${dia}/${m}/${a}${comHora && t ? ' ' + t.slice(0, 8) : ''}`
}

const endereco = (e: any) => [e?.xLgr, e?.nro, e?.xCpl, e?.xBairro].filter(Boolean).join(', ') || '-'

const SIMPLES: Record<string, string> = {
  '1': 'Não Optante',
  '2': 'Optante - Microempreendedor Individual (MEI)',
  '3': 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)',
}
const REG_AP_SN: Record<string, string> = {
  '1': 'Regime de apuração dos tributos federais e municipal pelo Simples Nacional',
  '2': 'Regime de apuração dos tributos federais pelo SN e o ISSQN pela NFS-e conforme legislação municipal',
  '3': 'Regime de apuração dos tributos federais e municipal pela NFS-e conforme legislações federal e municipal',
}
const TRIB_ISSQN: Record<string, string> = {
  '1': 'Operação Tributável', '2': 'Imunidade', '3': 'Exportação de Serviço', '4': 'Não Incidência',
}
const REG_ESP: Record<string, string> = {
  '0': 'Nenhum', '1': 'Ato Cooperado (Cooperativa)', '2': 'Estimativa', '3': 'Microempresa Municipal',
  '4': 'Notário ou Registrador', '5': 'Profissional Autônomo', '6': 'Sociedade de Profissionais',
}

/** Célula com rótulo em negrito pequeno e valor abaixo. */
const c = (rotulo: string, valor: unknown, span = 1, extra = '') =>
  `<div class="c s${span} ${extra}"><b>${esc(rotulo)}</b><span>${esc(valor === '' || valor == null ? '-' : valor)}</span></div>`
/** Célula-título de seção (fundo cinza). */
const h = (titulo: string, span = 1) => `<div class="c s${span} h">${esc(titulo)}</div>`
/** Linha de 4 colunas; a que abre seção (célula-título) leva a linha divisória acima, como no oficial. */
const row = (...cells: string[]) =>
  `<div class="r${cells[0]?.includes(' h">') ? ' sec' : ''}">${cells.join('')}</div>`

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'DejaVu Sans', Arial, Helvetica, sans-serif; color: #000; margin: 0; font-size: 8.8px; }
  .page { border: 1px solid #000; }
  .r { display: grid; grid-template-columns: repeat(4, 1fr); }
  .r.sec { border-top: 1px solid #000; }
  .c { padding: 1px 5px 2px; min-height: 22px; }
  .c b { display: block; font-size: 6.8px; font-weight: bold; }
  .c span { display: block; white-space: pre-wrap; }
  .s2 { grid-column: span 2; } .s3 { grid-column: span 3; } .s4 { grid-column: span 4; }
  .h { background: #e8e8e8; font-weight: bold; font-size: 8px; padding-top: 3px; }
  .cinza { background: #e8e8e8; }
  .topo { display: grid; grid-template-columns: 1.3fr 1.4fr 1.3fr; align-items: center; border-bottom: 1px solid #000; padding: 4px 5px; }
  .topo img { width: 190px; }
  .titulo { text-align: center; font-weight: bold; font-size: 11px; line-height: 1.35; }
  .amb { font-size: 11px; } .amb small { display: block; font-size: 8px; }
  .chave { display: grid; grid-template-columns: 3fr 1fr; border-bottom: 1px solid #000; }
  .chave .r { grid-template-columns: repeat(3, 1fr); }
  .chave .c { min-height: 21px; }
  .qr { text-align: center; padding: 4px; font-size: 7.5px; line-height: 1.25; }
  .qr img { width: 70px; height: 70px; display: block; margin: 0 auto 3px; }
  .aviso { border-top: 1px solid #000; text-align: center; font-size: 8.8px; padding: 13px 0; }
  .desc span { min-height: 118px; }
  .linha { padding: 3px 5px; }
  .info { min-height: 105px; padding: 14px 5px 5px; white-space: pre-wrap; }
  .rodape { border-top: 1px solid #000; }
  .rodape .c { min-height: 26px; }
`

export interface OpcoesDanfse {
  /**
   * Nome do município pelo código IBGE. Padrão: API de localidades do IBGE (com cache);
   * passe uma função própria para funcionar offline.
   */
  nomeMunicipio?: (codIbge: string) => Promise<string>
}

/**
 * HTML do DANFSe (leiaute DANFSe v2.0 do portal nacional) a partir do XML da NFS-e autorizada.
 * Página A4 única; renderize com qualquer motor HTML→PDF ou use `gerarDanfsePdf`.
 */
export async function gerarDanfseHtml(xmlNfse: string, opcoes: OpcoesDanfse = {}): Promise<string> {
  const nomeMunicipio = opcoes.nomeMunicipio ?? nomeMunicipioIbge
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, removeNSPrefix: true })
  const inf = parser.parse(xmlNfse)?.NFSe?.infNFSe
  if (!inf) throw new Error('[danfse] infNFSe não encontrado no XML.')
  const dps = inf.DPS?.infDPS ?? {}
  const emit = inf.emit ?? {}
  const prestReg = dps.prest?.regTrib ?? {}
  const toma = dps.toma
  const tomaEnd = toma?.end ?? {}
  const cServ = dps.serv?.cServ ?? {}
  const vals = dps.valores ?? {}
  const trib = vals.trib ?? {}
  const pisCofins = trib.tribFed?.piscofins
  const totTrib = trib.totTrib ?? {}
  const vt = totTrib.vTotTrib ?? {}
  const pt = totTrib.pTotTrib ?? {}
  const totaisAprox =
    totTrib.pTotTribSN != null
      ? `Alíquota do Simples Nacional: ${pct(totTrib.pTotTribSN)}`
      : totTrib.pTotTrib
        ? `Federais: ${pct(pt.pTotTribFed)} ; Estaduais: ${pct(pt.pTotTribEst)} ; Municipais: ${pct(pt.pTotTribMun)}`
        : totTrib.indTotTrib != null
          ? 'Não informados'
          : `Federais: ${brl(vt.vTotTribFed)} ; Estaduais: ${brl(vt.vTotTribEst)} ; Municipais: ${brl(vt.vTotTribMun)}`
  // IBS/CBS: classificação vem da DPS; base, alíquotas e valores são calculados pela Sefin (infNFSe/IBSCBS).
  const ibsDps = dps.IBSCBS
  const ibsTrib = ibsDps?.valores?.trib ?? {}
  const ibs = inf.IBSCBS ?? {}
  const ibsVal = ibs.valores ?? {}
  const ibsTot = ibs.totCIBS ?? {}
  const vIbs = ibsTot.gIBS?.vIBSTot
  const vCbs = ibsTot.gCBS?.vCBS
  const temIbsCbs = vIbs != null || vCbs != null
  const vIbsCbs = temIbsCbs ? Number(vIbs ?? 0) + Number(vCbs ?? 0) : null
  const chave = String(inf['@_Id'] ?? '').replace(/^NFS/, '')
  const vServ = vals.vServPrest?.vServ
  const vLiq = inf.valores?.vLiq ?? vServ

  const cMunPrest = String(emit.enderNac?.cMun ?? '')
  const cMunToma = String(tomaEnd.endNac?.cMun ?? '')
  const [munPrest, munToma] = await Promise.all([
    cMunPrest === String(dps.cLocEmi) && inf.xLocEmi ? inf.xLocEmi : nomeMunicipio(cMunPrest),
    nomeMunicipio(cMunToma),
  ])
  const munUf = (nome: string, cod: string) => (nome || cod ? `${nome || cod} / ${emit.enderNac?.UF && cod === cMunPrest ? emit.enderNac.UF : UF_POR_CODIGO[cod.slice(0, 2)] ?? ''}` : '-')

  const qr = await QRCode.toDataURL(URL_CONSULTA + chave, { margin: 1, width: 240, errorCorrectionLevel: 'M' })

  const tomador = toma
    ? row(h('TOMADOR / ADQUIRENTE'), c('CNPJ / CPF / NIF', fmtDoc(toma.CNPJ ?? toma.CPF ?? toma.NIF)), c('Indicador Municipal (Inscrição)', toma.IM), c('Telefone', fmtFone(toma.fone))) +
      row(c('Nome / Nome Empresarial', toma.xNome, 2), c('Município / Sigla UF', cMunToma ? munUf(munToma, cMunToma) : '-'), c('Código IBGE / CEP', cMunToma ? `${cMunToma} / ${fmtCep(tomaEnd.endNac?.CEP)}` : '-')) +
      row(c('Endereço', endereco(tomaEnd), 2), c('E-mail', toma.email, 2))
    : row(h('TOMADOR / ADQUIRENTE'), `<div class="c s3"><span>TOMADOR NÃO IDENTIFICADO NA NFS-e</span></div>`)

  const pis = pisCofins?.vPis != null ? brl(pisCofins.vPis) : '-'
  const cofins = pisCofins?.vCofins != null ? brl(pisCofins.vCofins) : '-'
  const descRet = pisCofins ? (String(pisCofins.tpRetPisCofins ?? '0') === '0' ? 'PIS/COFINS/CSLL Não Retidos' : 'PIS/COFINS/CSLL Retidos') : '-'
  const tpAmb = String(dps.tpAmb ?? '1')
  const cLocIbs = String(ibs.cLocalidadeIncid ?? '')
  const indOpLocal = ibsDps
    ? [ibsDps.cIndOp ?? '-', cLocIbs || '-', ibs.xLocalidadeIncid ?? '-', UF_POR_CODIGO[cLocIbs.slice(0, 2)] ?? '-'].join(' / ')
    : '-'
  const fmtVal = (v: unknown) => (v == null ? '-' : brl(v))

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><style>${CSS}</style></head><body><div class="page">
  <div class="topo">
    <div><img src="data:image/png;base64,${LOGO_NFSE_PNG_BASE64}" alt="NFS-e"></div>
    <div class="titulo">DANFSe v2.0<br>Documento Auxiliar da NFS-e</div>
    <div class="amb">${esc(munUf(String(inf.xLocEmi ?? ''), String(dps.cLocEmi ?? '')))}<small>Ambiente Gerador: ${esc(inf.ambGer ?? '-')}</small><small>Tipo de Ambiente: ${tpAmb === '1' ? 'Produção' : 'Produção Restrita'}</small></div>
  </div>
  <div class="chave">
    <div>
      ${row(c('CHAVE DE ACESSO DA NFS-E', chave, 3))}
      ${row(c('NÚMERO DA NFS-E', inf.nNFSe), c('COMPETÊNCIA DA NFS-E', fmtDataHora(dps.dCompet, false)), c('DATA E HORA DA EMISSÃO DA NFS-E', fmtDataHora(inf.dhProc, true)))}
      ${row(c('NÚMERO DA DPS', dps.nDPS), c('SÉRIE DA DPS', dps.serie), c('DATA E HORA DA EMISSÃO DA DPS', fmtDataHora(dps.dhEmi, true)))}
      ${row(c('EMITENTE DA NFS-E', String(dps.tpEmit ?? '1') === '1' ? 'Prestador' : String(dps.tpEmit) === '2' ? 'Tomador' : 'Intermediário', 1, 'cinza'), c('SITUAÇÃO DA NFS-E', 'Regular'), c('FINALIDADE', '-'))}
    </div>
    <div class="qr"><img src="${qr}" alt="QR Code">A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e</div>
  </div>
  ${row(h('PRESTADOR / FORNECEDOR'), c('CNPJ / CPF / NIF', fmtDoc(emit.CNPJ ?? emit.CPF)), c('Indicador Municipal (Inscrição)', emit.IM), c('Telefone', fmtFone(emit.fone)))}
  ${row(c('Nome / Nome Empresarial', emit.xNome, 2), c('Município / Sigla UF', munUf(munPrest, cMunPrest)), c('Código IBGE / CEP', `${cMunPrest || '-'} / ${fmtCep(emit.enderNac?.CEP)}`))}
  ${row(c('Endereço', endereco(emit.enderNac), 2), c('E-mail', emit.email, 2))}
  ${row(c('Simples Nacional na Data de Competência', SIMPLES[String(prestReg.opSimpNac)] ?? '-', 2), c('Regime de Apuração Tributária pelo SN', REG_AP_SN[String(prestReg.regApTribSN)] ?? '-', 2))}
  ${tomador}
  <div class="aviso">O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO</div>
  <div class="aviso">INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e</div>
  ${row(h('SERVIÇO PRESTADO'), c('Código de Tributação Nacional / Municipal', `${cServ.cTribNac ?? '-'} / ${cServ.cTribMun ?? '-'}`), c('Código da NBS', cServ.cNBS), c('Local da Prestação / Sigla UF / País', `${inf.xLocPrestacao ?? '-'} / ${UF_POR_CODIGO[String(dps.serv?.locPrest?.cLocPrestacao ?? '').slice(0, 2)] ?? ''}`))}
  <div class="linha">${esc(inf.xTribNac ?? '')}</div>
  ${row(c('Descrição do Serviço', cServ.xDescServ, 4, 'desc'))}
  ${row(h('TRIBUTAÇÃO MUNICIPAL (ISSQN)'), c('Tipo de Tributação do ISSQN', TRIB_ISSQN[String(trib.tribMun?.tribISSQN)] ?? '-'), c('Município / Sigla UF / País da Incidência do ISSQN', inf.xLocIncid ? `${inf.xLocIncid} / ${UF_POR_CODIGO[String(inf.cLocIncid ?? '').slice(0, 2)] ?? ''}` : '-', 2))}
  ${row(c('Regime Especial de Tributação do ISSQN', REG_ESP[String(prestReg.regEspTrib ?? '0')] ?? '-'), c('Tipo de Imunidade do ISSQN', '-'), c('Suspensão da Exigibilidade do ISSQN', '-'), c('Número Processo Suspensão', '-'))}
  ${row(c('Benefício Municipal', '-'), c('Cálculo do BM', '-'), c('Total Deduções/Reduções', '-'), c('Desconto Incondicionado', '-'))}
  ${row(c('BC ISSQN', '-'), c('Alíquota Aplicada', '-'), c('Retenção do ISSQN', String(trib.tribMun?.tpRetISSQN ?? '1') === '1' ? 'Não Retido' : 'Retido'), c('ISSQN Apurado', '-'))}
  ${row(h('TRIBUTAÇÃO FEDERAL (EXCETO CBS)'), c('IRRF', '-'), c('Contribuição Previdenciária - Retida', '-'), c('Contribuições Sociais - Retidas', '-'))}
  ${row(c('PIS - Débito Apuração Própria', pis), c('COFINS - Débito Apuração Própria', cofins), c('Descrição Contrib. Sociais - Retidas', descRet, 2))}
  ${row(h('TRIBUTAÇÃO IBS / CBS'), c('CST / cClassTrib', ibsDps ? `${ibsTrib.CST ?? '-'} / ${ibsTrib.cClassTrib ?? '-'}` : '-'), c('Indicador de Operação / Código IBGE Incidência / Município / Sigla UF', indOpLocal, 2))}
  ${row(c('Exclusões e Reduções da Base de Cálculo', brl(ibsVal.vCalcAjusteBCIBSCBS ?? ibsVal.vCalcAjusteBCLocImoveis ?? 0)), c('Base de Cálculo Após Exclusões e Reduções', fmtVal(ibsVal.vBC)), c('Red. Alíquota IBS / Red. Alíquota CBS', ibsVal.uf || ibsVal.fed ? `${pct(ibsVal.uf?.pRedAliqUF ?? 0)} / ${pct(ibsVal.fed?.pRedAliqCBS ?? 0)}` : '-'), c('Alíquota - IBS UF / IBS Mun', ibsVal.uf || ibsVal.mun ? `${pct(ibsVal.uf?.pIBSUF)} / ${pct(ibsVal.mun?.pIBSMun)}` : '-'))}
  ${row(c('Alíq. Efetiva Municipal - IBS', pct(ibsVal.mun?.pAliqEfetMun)), c('Valor Apurado Municipal - IBS', fmtVal(ibsTot.gIBS?.gIBSMunTot?.vIBSMun)), c('Alíq. Efetiva Estadual - IBS', pct(ibsVal.uf?.pAliqEfetUF)), c('Valor Apurado Estadual - IBS', fmtVal(ibsTot.gIBS?.gIBSUFTot?.vIBSUF)))}
  ${row(c('Valor Total Apurado - IBS', fmtVal(vIbs)), c('Alíquota - CBS', pct(ibsVal.fed?.pCBS)), c('Alíquota Efetiva - CBS', pct(ibsVal.fed?.pAliqEfetCBS)), c('Valor Total Apurado - CBS', fmtVal(vCbs)))}
  ${row(h('VALOR TOTAL DA NFS-E'), c('Valor da Operação / Serviço', brl(vServ)), c('Desconto Incondicionado', '-'), c('Desconto Condicionado', '-'))}
  ${row(c('Total das Retenções (ISSQN / Federais)', '-'), c('Valor Líquido da NFS-e', brl(vLiq)), c('Total do IBS/CBS', fmtVal(vIbsCbs)), c('Valor Líquido da NFS-e + IBS/CBS', brl(ibsTot.vTotNF ?? (Number(vLiq ?? 0) + (vIbsCbs ?? 0))), 1, 'cinza'))}
  ${row(h('INFORMAÇÕES COMPLEMENTARES'), '<div class="c s3"></div>')}
  <div class="info">Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: ${esc(totaisAprox)}</div>
  <div class="rodape">${row(c('Data Cientificação', '-'), c('Identificação e Assinatura', '-'), c('Nº NFS-e / Chave NFS-e', chave, 2))}</div>
</div></body></html>`

  return html
}

export interface OpcoesPdf extends OpcoesDanfse {
  /** Caminho do Chrome/Chromium. Padrão: o do puppeteer (ou /usr/bin/google-chrome se existir). */
  executablePath?: string
  /** Browser puppeteer já aberto (reaproveitado em lote; não é fechado aqui). */
  browser?: any
}

/**
 * PDF do DANFSe gerado localmente — use quando o ADN (`baixarDanfse`) não entregar o oficial.
 * Requer o pacote `puppeteer` instalado no projeto (dependência opcional).
 */
export async function gerarDanfsePdf(xmlNfse: string, opcoes: OpcoesPdf = {}): Promise<Buffer> {
  const html = await gerarDanfseHtml(xmlNfse, opcoes)
  let browser = opcoes.browser
  if (!browser) {
    let puppeteer: any
    try {
      const nome = 'puppeteer'
      puppeteer = (await import(nome)).default
    } catch {
      throw new Error('[danfse] gerarDanfsePdf requer o pacote "puppeteer" (npm i puppeteer). Alternativa: gerarDanfseHtml + seu próprio conversor.')
    }
    const executablePath =
      opcoes.executablePath ?? (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
    browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'], ...(executablePath ? { executablePath } : {}) })
  }
  try {
    const page = await browser.newPage()
    try {
      await page.setContent(html, { waitUntil: 'load' })
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '22px', bottom: '22px', left: '26px', right: '26px' },
      })
      return Buffer.from(pdf)
    } finally {
      await page.close()
    }
  } finally {
    if (!opcoes.browser) await browser.close()
  }
}
