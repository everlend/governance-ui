import { PublicKey, Transaction } from '@solana/web3.js'
import {
  getInstructionDataFromBase64,
  ProgramAccount,
  Realm,
  RpcContext,
  serializeInstructionToBase64,
  TokenOwnerRecord,
} from '@solana/spl-governance'
import { BN } from '@project-serum/anchor'
import { AssetAccount } from '@utils/uiTypes/assets'
import { ConnectionContext } from '@utils/connection'
import { VotingClient } from '@utils/uiTypes/VotePlugin'
import {
  createProposal,
  InstructionDataWithHoldUpTime,
} from 'actions/createProposal'
import tokenService from '@utils/services/token'
import {
  prepareDepositTx,
  prepareWithdrawalRequestTx,
  Pool,
} from '@everlend/general-pool'
import axios from 'axios'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { prepareSolDepositTx } from './preparedSolDepositTx'

const MARKET_MAIN = 'DzGDoJHdzUANM7P7V25t5nxqbvzRcHDmdhY51V6WNiXC'
const MARKET_DEV = '4yC3cUWXQmoyyybfnENpxo33hiNxUNa1YAmmuxz93WAJ'
const REGISTRY_DEV = '6KCHtgSGR2WDE3aqrqSJppHRGVPgy9fHDX5XD8VZgb61'
const REGISTRY_MAIN = 'UaqUGgMvVzUZLthLHC9uuuBzgw5Ldesich94Wu5pMJg'
const ENDPOINT = 'https://api.everlend.finance/api/v1/'
export const EVERLEND = 'Everlend'

async function getAPYs() {
  const api = axios.create({
    baseURL: ENDPOINT,
    timeout: 30000,
  })

  return api.get('apy')
}

async function getStrategies(connection: ConnectionContext) {
  const POOL_MARKET_PUBKEY = new PublicKey(
    connection.cluster === 'mainnet' ? MARKET_MAIN : MARKET_DEV
  )

  try {
    const response = await Pool.findMany(connection.current, {
      poolMarket: POOL_MARKET_PUBKEY,
    })

    const apys = await getAPYs()

    const strategies = response.map((pool) => {
      const { tokenMint, poolMint } = pool.data
      const tokenInfo = tokenService.getTokenInfo(tokenMint.toString())
      const apy =
        apys.data.find((apy) => apy.token === tokenInfo?.symbol)?.supply_apy *
          100 ?? 0
      return {
        handledMint: tokenMint.toString(),
        createProposalFcn: handleEverlendAction,
        protocolLogoSrc: '/realms/Everlend/img/logo.png',
        protocolName: 'Everlend',
        protocolSymbol: 'evd',
        isGenericItem: false,
        poolMint: poolMint.toString(),
        poolPubKey: pool.publicKey.toString(),
        strategyDescription: '',
        strategyName: 'Deposit',
        handledTokenSymbol: tokenInfo?.symbol,
        handledTokenImgSrc: tokenInfo?.logoURI,
        apy: apy.toFixed(2).concat('%'),
      }
    })

    return strategies
  } catch (e) {
    console.log(e)
  }
}

export async function handleEverlendAction(
  rpcContext: RpcContext,
  form: {
    action: 'Deposit' | 'Withdraw'
    title: string
    description: string
    bnAmount: BN
    poolPubKey: string
    tokenMint: string
    poolMint: string
  },
  realm: ProgramAccount<Realm>,
  matchedTreasury: AssetAccount,
  tokenOwnerRecord: ProgramAccount<TokenOwnerRecord>,
  governingTokenMint: PublicKey,
  proposalIndex: number,
  isDraft: boolean,
  connection: ConnectionContext,
  client?: VotingClient
) {
  const isSol = matchedTreasury.isSol
  const insts: InstructionDataWithHoldUpTime[] = []
  const owner = isSol
    ? matchedTreasury!.pubkey
    : matchedTreasury!.extensions!.token!.account.owner
  const REGISTRY = new PublicKey(
    connection.cluster === 'mainnet' ? REGISTRY_MAIN : REGISTRY_DEV
  )
  // const tokenMintPubKey = new PublicKey(form.tokenMint)
  // const poolMintPubKey = new PublicKey(form.poolMint)
  // const destination = await findAssociatedTokenAccount(owner, poolMintPubKey)
  // const source = await findAssociatedTokenAccount(owner, tokenMintPubKey)

  const ctokenATA = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(form.tokenMint),
    owner,
    true
  )

  const liquidityATA = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(form.poolMint),
    owner,
    true
  )

  const setupInsts: InstructionDataWithHoldUpTime[] = []
  const cleanupInsts: InstructionDataWithHoldUpTime[] = []

  if (form.action === 'Deposit') {
    let actionTx: Transaction
    if (isSol) {
      const { tx: depositTx } = await prepareSolDepositTx(
        { connection: connection.current, payerPublicKey: owner },
        new PublicKey(form.poolPubKey),
        REGISTRY,
        form.bnAmount,
        ctokenATA,
        liquidityATA
      )
      actionTx = depositTx
    } else {
      const { tx: depositTx } = await prepareDepositTx(
        { connection: connection.current, payerPublicKey: owner },
        new PublicKey(form.poolPubKey),
        REGISTRY,
        form.bnAmount,
        ctokenATA
      )
      actionTx = depositTx
    }

    actionTx.instructions.map((instruction) => {
      insts.push({
        data: getInstructionDataFromBase64(
          serializeInstructionToBase64(instruction)
        ),
        holdUpTime: matchedTreasury.governance!.account!.config
          .minInstructionHoldUpTime,
        prerequisiteInstructions: [],
      })
    })
  } else if (form.action === 'Withdraw') {
    const { tx: withdrawslTx } = await prepareWithdrawalRequestTx(
      {
        connection: connection.current,
        payerPublicKey: owner,
      },
      new PublicKey(form.poolPubKey),
      REGISTRY,
      form.bnAmount,
      liquidityATA,
      isSol ? owner : undefined
    )

    withdrawslTx.instructions.map((instruction) => {
      insts.push({
        data: getInstructionDataFromBase64(
          serializeInstructionToBase64(instruction)
        ),
        holdUpTime: matchedTreasury.governance!.account!.config
          .minInstructionHoldUpTime,
        prerequisiteInstructions: [],
        chunkSplitByDefault: true,
      })
    })

    if (isSol) {
      const closeWSOLAccountIx = Token.createCloseAccountInstruction(
        TOKEN_PROGRAM_ID,
        ctokenATA,
        owner,
        owner,
        []
      )
      cleanupInsts.push({
        data: getInstructionDataFromBase64(
          serializeInstructionToBase64(closeWSOLAccountIx)
        ),
        holdUpTime: matchedTreasury.governance!.account!.config
          .minInstructionHoldUpTime,
        prerequisiteInstructions: [],
        chunkSplitByDefault: true,
      })
    }
  }

  const proposalAddress = await createProposal(
    rpcContext,
    realm,
    matchedTreasury.governance!.pubkey,
    tokenOwnerRecord,
    form.title,
    form.description,
    governingTokenMint,
    proposalIndex,
    [...setupInsts, ...insts, ...cleanupInsts],
    isDraft,
    client
  )
  return proposalAddress
}

export async function getEverlendStrategies(
  connection: ConnectionContext
): Promise<any> {
  const strategies = await getStrategies(connection)

  return strategies
}

export type CreateEverlendProposal = (
  rpcContext: RpcContext,
  form: {
    action: 'Deposit' | 'Withdraw'
    title: string
    description: string
    bnAmount: BN
    amountFmt: string
    poolPubKey: string
    tokenMint: string
    poolMint: string
  },
  realm: ProgramAccount<Realm>,
  matchedTreasury: AssetAccount,
  tokenOwnerRecord: ProgramAccount<TokenOwnerRecord>,
  governingTokenMint: PublicKey,
  proposalIndex: number,
  isDraft: boolean,
  connection: ConnectionContext,
  client?: VotingClient
) => Promise<PublicKey>
