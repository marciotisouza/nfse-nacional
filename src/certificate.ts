import forge from 'node-forge'

export interface CertificateData {
  /** Chave privada em PEM (para assinar o XML). */
  privateKeyPem: string
  /** Certificado do titular em Base64 (DER, sem cabeçalhos) — vai no X509Certificate da assinatura. */
  certBase64: string
}

function abrirPfx(pfxBuf: Buffer, senha: string) {
  return forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfxBuf.toString('binary')), false, senha)
}

function chavePrivada(pfx: forge.pkcs12.Pkcs12Pfx): forge.pki.rsa.PrivateKey {
  const bag = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
  const key = bag?.[0]?.key ?? pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key
  if (!key) throw new Error('Chave privada não encontrada no certificado.')
  return key as forge.pki.rsa.PrivateKey
}

function certificados(pfx: forge.pkcs12.Pkcs12Pfx): forge.pki.Certificate[] {
  const bags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
  const certs = bags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c)
  if (!certs.length) throw new Error('Certificado público não encontrado no .pfx.')
  return certs
}

/** Certificado do titular: o que corresponde à chave privada (o .pfx pode trazer a cadeia junto). */
function certificadoDoTitular(pfx: forge.pkcs12.Pkcs12Pfx): forge.pki.Certificate {
  const key = chavePrivada(pfx)
  const certs = certificados(pfx)
  return certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n)) ?? certs[0]
}

/** Chave privada (PEM) e certificado (Base64) para a assinatura XMLDSig. */
export function extrairDadosCertificado(pfxBuf: Buffer, senha: string): CertificateData {
  const pfx = abrirPfx(pfxBuf, senha)
  const certBase64 = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificadoDoTitular(pfx))).getBytes(),
  )
  return { privateKeyPem: forge.pki.privateKeyToPem(chavePrivada(pfx)), certBase64 }
}

const _tlsCache = new Map<string, { key: string; cert: string }>()

/**
 * Chave privada e cadeia de certificados em PEM, para o mTLS (`https.Agent({ key, cert })`).
 * O Node 22 / OpenSSL 3 recusa .pfx com cifras legadas (RC2/3DES) em `https.Agent({ pfx })`
 * ("Unsupported PKCS12 PFX data"), caso da maioria dos certificados A1 — o node-forge abre.
 */
export function extrairPemTls(pfxBuf: Buffer, senha: string): { key: string; cert: string } {
  const cacheKey = pfxBuf.toString('base64').slice(-64)
  const cached = _tlsCache.get(cacheKey)
  if (cached) return cached
  const pfx = abrirPfx(pfxBuf, senha)
  const titular = certificadoDoTitular(pfx)
  const cadeia = [titular, ...certificados(pfx).filter((c) => c !== titular)]
  const result = {
    key: forge.pki.privateKeyToPem(chavePrivada(pfx)),
    cert: cadeia.map((c) => forge.pki.certificateToPem(c)).join(''),
  }
  _tlsCache.set(cacheKey, result)
  return result
}

export interface InfoCertificado {
  /** Nome do titular (CN sem o documento). */
  titular: string
  /** CNPJ do titular (e-CNPJ), se houver. */
  cnpj: string | null
  /** CPF do titular (e-CPF) ou do responsável, se houver. */
  cpf: string | null
  /** Autoridade certificadora emissora (CN do emissor). */
  emissor: string
  numeroSerie: string
  validoDe: Date
  validoAte: Date
  /** Dias até expirar (negativo = expirado). */
  diasRestantes: number
  expirado: boolean
  /** true se ainda válido, mas expira em até `diasAviso` dias. */
  vencendo: boolean
  /** true se a data atual ainda é anterior ao início da validade. */
  aindaNaoValido: boolean
}

/** Lê os valores de um otherName do subjectAltName (ICP-Brasil guarda CNPJ/CPF ali). */
function otherNames(cert: forge.pki.Certificate): Record<string, string> {
  const ext = cert.getExtension('subjectAltName') as any
  const out: Record<string, string> = {}
  try {
    const asn1 = forge.asn1.fromDer(ext?.value ?? '')
    for (const gn of (asn1.value as forge.asn1.Asn1[]) ?? []) {
      if (gn.type !== 0) continue // [0] otherName
      const [oid, valor] = gn.value as forge.asn1.Asn1[]
      const oidStr = forge.asn1.derToOid(oid.value as string)
      let v: any = valor
      while (v && Array.isArray(v.value)) v = v.value[0]
      if (v && typeof v.value === 'string') out[oidStr] = v.value
    }
  } catch {}
  return out
}

/**
 * Dados e validade do certificado A1: titular, CNPJ/CPF, emissor e situação.
 * Lança erro se a senha estiver errada ou o arquivo não for um .pfx válido.
 *
 * @param opcoes.diasAviso  Janela para `vencendo` (padrão 30 dias)
 */
export function verificarCertificado(pfxBuf: Buffer, senha: string, opcoes: { diasAviso?: number } = {}): InfoCertificado {
  let pfx: forge.pkcs12.Pkcs12Pfx
  try {
    pfx = abrirPfx(pfxBuf, senha)
  } catch (e: any) {
    throw new Error(`Não foi possível abrir o certificado (senha incorreta ou arquivo inválido): ${e?.message ?? e}`)
  }
  const cert = certificadoDoTitular(pfx)
  const cn = String(cert.subject.getField('CN')?.value ?? '')
  const [nome, docCn] = cn.split(':')
  const san = otherNames(cert)
  // OIDs ICP-Brasil: 2.16.76.1.3.3 = CNPJ; 2.16.76.1.3.1 / 2.16.76.1.3.4 = dados do titular/responsável (CPF nas posições 8-19).
  const cnpjSan = san['2.16.76.1.3.3']?.replace(/\D/g, '')
  const cpfSan = (san['2.16.76.1.3.1'] ?? san['2.16.76.1.3.4'])?.slice(8, 19).replace(/\D/g, '')
  const docDigitos = (docCn ?? '').replace(/\D/g, '')
  const cnpj = cnpjSan?.length === 14 ? cnpjSan : docDigitos.length === 14 ? docDigitos : null
  const cpf = cpfSan?.length === 11 && cpfSan !== '00000000000' ? cpfSan : docDigitos.length === 11 ? docDigitos : null

  const agora = Date.now()
  const validoAte = cert.validity.notAfter
  const diasRestantes = Math.floor((validoAte.getTime() - agora) / 86_400_000)
  const expirado = validoAte.getTime() < agora
  return {
    titular: (docCn !== undefined ? nome : cn).trim(),
    cnpj,
    cpf,
    emissor: String(cert.issuer.getField('CN')?.value ?? ''),
    numeroSerie: cert.serialNumber,
    validoDe: cert.validity.notBefore,
    validoAte,
    diasRestantes,
    expirado,
    vencendo: !expirado && diasRestantes <= (opcoes.diasAviso ?? 30),
    aindaNaoValido: cert.validity.notBefore.getTime() > agora,
  }
}
