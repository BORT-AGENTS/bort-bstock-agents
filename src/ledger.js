// The agent's daily record: desk pages hashed into a Merkle tree whose root is anchored on chain
// by StockAgentLogicV1.anchor_notes, once before the US open (phase 1) and once after the close
// (phase 2). Anyone holding a page and its proof can check it with verifyPage (off chain) or
// StockAgentLogicV1.verifyAnchored (on chain), and compare the anchor time with the session.
//
// Pages are plain JSON objects. Keep numbers as decimal STRINGS (prices, balances, multipliers):
// the page hash is taken over canonical JSON, and float formatting is not stable across tools.
'use strict';

const { StandardMerkleTree } = require('@openzeppelin/merkle-tree');
const { keccak256, toUtf8Bytes, defaultAbiCoder } = require('ethers').utils;

const PHASE = Object.freeze({ OPEN: 1, CLOSE: 2 });

/** JSON with object keys sorted at every level and no whitespace, so equal pages hash equally. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new Error(`page holds a fractional number (${value}); store it as a decimal string`);
  }
  return JSON.stringify(value);
}

function pageHash(page) {
  return keccak256(toUtf8Bytes(canonical(page)));
}

/**
 * Builds the tree for one day and phase. Returns the root to anchor and, for every page, the
 * leaf and proof that verifyAnchored expects.
 */
function buildTree(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('a tree needs at least one page');
  const values = pages.map((p) => [pageHash(p)]);
  const tree = StandardMerkleTree.of(values, ['bytes32']);
  return {
    root: tree.root,
    tree,
    entries: pages.map((page, i) => ({
      page,
      pageHash: values[i][0],
      leaf: tree.leafHash(values[i]),
      proof: tree.getProof(values[i]),
    })),
  };
}

/**
 * The leaf StandardMerkleTree uses for a page: keccak256(keccak256(abi.encode(bytes32 pageHash))).
 * StockAgentLogicV1.verifyAnchored and verifyLearning take the page hash and derive this leaf
 * themselves, so an inner node of the tree cannot pass as a page.
 */
function leafOf(page) {
  return keccak256(keccak256(defaultAbiCoder.encode(['bytes32'], [pageHash(page)])));
}

/** Off-chain check of one page against an anchored root. */
function verifyPage(root, page, proof) {
  return StandardMerkleTree.verify(root, ['bytes32'], [pageHash(page)], proof);
}

/** yyyymmdd for a Date in UTC: the human-readable day written inside the pages. */
function dayKey(date = new Date()) {
  return Number(date.toISOString().slice(0, 10).replace(/-/g, ''));
}

/**
 * The UTC day number (days since 1970-01-01) for a unix timestamp in seconds: the key the contract
 * anchors under. The contract takes it from the anchoring block, never from the caller.
 */
function epochDay(unixSeconds = Math.floor(Date.now() / 1000)) {
  return Math.floor(Number(unixSeconds) / 86400);
}

module.exports = { PHASE, canonical, pageHash, leafOf, buildTree, verifyPage, dayKey, epochDay };
