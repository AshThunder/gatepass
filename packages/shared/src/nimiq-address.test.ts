import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  addressFromPublicKey,
  isNqAddress,
  normalizeNqAddress,
  verifyNimiqSignature,
} from './nimiq-address.js'
import { bytesToHex, utf8ToBytes } from './totp.js'

describe('Nimiq address helpers', () => {
  it('matches a known Albatross public key → NQ address', () => {
    const pub = '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29'
    const addr = addressFromPublicKey(pub)
    assert.equal(addr, 'NQ17 D2ES UBTP N14D RG4E 2KBK 217A 2GH2 NNY1')
  })

  it('accepts spaced NQ user-friendly addresses', () => {
    const { publicKey } = ed25519.keygen()
    const addr = addressFromPublicKey(bytesToHex(publicKey))
    assert.equal(isNqAddress(addr), true)
    assert.equal(normalizeNqAddress(addr).length, 36)
  })

  it('rejects obviously invalid addresses', () => {
    assert.equal(isNqAddress('NQ07 DEMO BUYER 0000 0000 0000 0000 0000'), false)
    assert.equal(isNqAddress('not-an-address'), false)
  })

  it('verifies a raw Ed25519 signature over the challenge', () => {
    const { secretKey, publicKey } = ed25519.keygen()
    const message = 'gp:challenge-test'
    const signature = ed25519.sign(utf8ToBytes(message), secretKey)
    assert.equal(
      verifyNimiqSignature(message, bytesToHex(publicKey), bytesToHex(signature)),
      true,
    )
    assert.equal(
      verifyNimiqSignature('other', bytesToHex(publicKey), bytesToHex(signature)),
      false,
    )
  })
})
