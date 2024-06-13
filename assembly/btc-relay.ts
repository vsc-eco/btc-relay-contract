import { db, Arrays, SystemAPI, Crypto, reverseEndianness } from '@vsc.eco/sdk/assembly';
import { JSON, JSONEncoder } from "assemblyscript-json/assembly";
import { BigInt } from "as-bigint/assembly"
import { calcKey, extractPrevBlockLE, getHeaders, getStringFromJSON, extractMerkleRootLE, hash256 } from './btc-relay-utils';
import { Value } from 'assemblyscript-json/assembly/JSON';

const DIFF_ONE_TARGET = BigInt.fromString('0xffff0000000000000000000000000000000000000000000000000000');

const MAX_DIFFICULTY = BigInt.fromString("0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

const FIRST_DIFFICULTY_PERIOD_HEADER = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";

const DEFAULT_VALIDITY_DEPTH = 6;

const RETARGET_PERIOD = BigInt.from(1209600);

const RETARGET_PERIOD_BLOCKS = 2016;

const headersState: Map<string, Map<i64, string>> = new Map<string, Map<i64, string>>();

class DifficultyPeriodParams {
    startTimestamp: i64;
    endTimestamp: i64;
    difficulty: BigInt;

    constructor(difficulty: BigInt, startTimestamp: i64, endTimestamp: i64 = 0) {
        this.startTimestamp = startTimestamp;
        this.endTimestamp = endTimestamp;
        this.difficulty = difficulty;
    }
}

// pla: for serialization and storage in the db, we convert BigInt to string and Uint8Array to hex string
export class Header {
    prevBlock: Uint8Array;
    timestamp: string;
    merkleRoot: Uint8Array;
    diff: BigInt;
    diffUnformatted: BigInt;
    totalDiff: BigInt;
    height: i32;
    raw: string;

    constructor(
        prevBlock: Uint8Array,
        timestamp: string,
        merkleRoot: Uint8Array,
        diff: BigInt,
        diffUnformatted: BigInt,
        totalDiff: BigInt,
        height: i32,
        raw: string
    ) {
        this.prevBlock = prevBlock;
        this.timestamp = timestamp;
        this.merkleRoot = merkleRoot;
        this.diff = diff;
        this.diffUnformatted = diffUnformatted;
        this.totalDiff = totalDiff;
        this.height = height;
        this.raw = raw;
    }

    stringify(encoder: JSONEncoder, key: string | null = null): JSONEncoder {
        encoder.pushObject(key);
        encoder.setString("prevBlock", Arrays.toHexString(this.prevBlock));
        encoder.setString("timestamp", this.timestamp);
        encoder.setString("merkleRoot", Arrays.toHexString(this.merkleRoot));
        encoder.setString("diff", this.diff.toString());
        encoder.setString("diffUnformatted", this.diffUnformatted.toString());
        encoder.setString("totalDiff", this.totalDiff.toString());
        encoder.setInteger("height", this.height);
        encoder.setString("raw", this.raw);
        return encoder;
    }
}

export class InitData {
    startHeader: string;
    height: i32;
    previousDifficulty: BigInt;
    lastDifficultyPeriodRetargetBlock: string | null = null;
    // pla: directs how many blocks to skip from the end of the chain, 0 no blocks are skipped
    // default validity depth is 6 blocks, this means we skip the last 6 blocks from the end of the chain, because we cant assume that they are final yet
    validityDepth: i32 = DEFAULT_VALIDITY_DEPTH;

    constructor(startHeader: string, height: i32, previousDifficulty: BigInt) {
        this.startHeader = startHeader;
        this.height = height;
        this.previousDifficulty = previousDifficulty;
    }
}

export class ProcessData {
    headers: Array<string>;

    constructor(headers: Array<string>) {
        this.headers = headers;
    }
}

export function getIntFromJSON(jsonObject: JSON.Obj, key: string): i64 {
    let extractedValue: JSON.Integer | null = jsonObject.getInteger(key);
    if (extractedValue != null) {
        return extractedValue.valueOf();
    }

    return 0;
}

export function getPreheaders(): Map<string, Header> {
    const fetchedPreHeaders = db.getObject(`pre-headers/main`);
    const preheaders: Map<string, Header> = new Map<string, Header>();

    if (fetchedPreHeaders !== "null") {
        let parsed = <JSON.Obj>JSON.parse(fetchedPreHeaders);
        for (let i = 0; i < parsed.keys.length; ++i) {
            let key = parsed.keys[i];
            let obj = parsed.get(key);
            if (obj instanceof JSON.Obj) {
                let preheader = new Header(
                    Arrays.fromHexString(getStringFromJSON(<JSON.Obj>obj, "prevBlock")),
                    getStringFromJSON(<JSON.Obj>obj, "timestamp"),
                    Arrays.fromHexString(getStringFromJSON(<JSON.Obj>obj, "merkleRoot")),
                    BigInt.from(getStringFromJSON(<JSON.Obj>obj, "diff")),
                    BigInt.from(getStringFromJSON(<JSON.Obj>obj, "diffUnformatted")),
                    BigInt.from(getStringFromJSON(<JSON.Obj>obj, "totalDiff")),
                    getIntFromJSON(<JSON.Obj>obj, "height") as i32,
                    getStringFromJSON(<JSON.Obj>obj, "raw")
                );
                preheaders.set(key, preheader);
            }
        }
    }

    return preheaders;
}

export function parseProcessData(headerString: string): ProcessData {
    const parsed = <JSON.Obj>JSON.parse(headerString);

    const headers = parsed.getArr('headers')!.valueOf().map<string>((value: Value, index: i32, array: Value[]) => {
        return value.toString();
    });

    return new ProcessData(headers);
}

export function parseInitData(initDataString: string): InitData {
    const parsed = <JSON.Obj>JSON.parse(initDataString);
    const initData = new InitData(
        getStringFromJSON(parsed, 'startHeader'),
        getIntFromJSON(parsed, 'height') as i32,
        BigInt.fromString(getStringFromJSON(parsed, 'previousDifficulty')),
    );

    let validityDepthJSON: JSON.Integer | null = parsed.getInteger('validityDepth');
    if (validityDepthJSON != null) {
        initData.validityDepth = validityDepthJSON.valueOf() as i32
    }

    let lastDifficultyPeriodRetargetBlockJSON: JSON.Str | null = parsed.getString('lastDifficultyPeriodRetargetBlock');
    if (lastDifficultyPeriodRetargetBlockJSON != null) {
        initData.lastDifficultyPeriodRetargetBlock = lastDifficultyPeriodRetargetBlockJSON.valueOf();
    }
    
    return initData;
}

export function validateHeaderPrevHashLE(header: Uint8Array, prevHeaderDigest: Uint8Array): boolean {
    // Extract prevHash of current header
    const prevHashLE = extractPrevBlockLE(header);

    // Compare prevHash of current header to previous header's digest
    if (!typedArraysAreEqual(prevHashLE, prevHeaderDigest)) {
        return false;
    }

    return true;
}

export function bytesToUint(uint8Arr: Uint8Array): i64 {
    let total: i64 = 0;
    for (let i = 0; i < uint8Arr.length; i += 1) {
        total += <u64>uint8Arr[i] << ((<u64>uint8Arr.length - i - 1) * 8);
    }
    return total;
}

// * Target is a 256 bit number encoded as a 3-byte mantissa
// * and 1 byte exponent
export function extractTarget(header: Uint8Array): BigInt {
    const m: Uint8Array = header.slice(72, 75);
    const e: i8 = header[75];

    const mantissa: i64 = bytesToUint(reverseEndianness(m));

    const exponent: i8 = e - 3;

    const power: BigInt = BigInt.from(256).pow(exponent);

    return power.mul(BigInt.from(mantissa));
}

export function validateHeaderWork(digest: Uint8Array, target: BigInt): boolean {
    if (typedArraysAreEqual(digest, new Uint8Array(32))) {
        return false;
    }

    const uInt: i64 = bytesToUint(reverseEndianness(digest));

    return target.gt(uInt);
}

export function typedArraysAreEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
        throw new Error('Arrays must be of type Uint8Array');
    }

    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function calculateDifficulty(target: BigInt): BigInt {
    return DIFF_ONE_TARGET.div(target);
}

export function validateHeaderChain(headers: Uint8Array): BigInt {
    if (headers.length % 80 !== 0) {
        throw new Error('Header bytes not multiple of 80.');
    }

    let digest: Uint8Array = new Uint8Array(0);
    let totalDifficulty: BigInt = BigInt.from(0);

    for (let i = 0; i < headers.length / 80; i += 1) {
        // ith header start index and ith header
        const start = i * 80;
        const header = headers.slice(start, start + 80);

        // After the first header, check that headers are in a chain
        if (i !== 0) {
            if (!validateHeaderPrevHashLE(header, digest)) {
                throw new Error('Header bytes not a valid chain.');
            }
        }

        // ith header target
        const target = extractTarget(header);

        // Require that the header has sufficient work
        digest = hash256(header);
        if (!validateHeaderWork(digest, target)) {
            throw new Error('Header does not meet its own difficulty target.');
        }

        totalDifficulty = totalDifficulty.add(calculateDifficulty(target));
    }

    return totalDifficulty;
}

export function extractTimestampLE(header: Uint8Array): Uint8Array {
    return header.slice(68, 72);
}

export function extractTimestamp(header: Uint8Array): i64 {
    return bytesToUint(reverseEndianness(extractTimestampLE(header)));
}

export function isZeroFilled(block: Uint8Array): bool {
    for (let i = 0, k = block.length; i < k; ++i) {
        if (block[i] !== 0) return false;
    }
    return true;
}

export function sortPreheadersByTotalDiff(preheaders: Map<string, Header>): Array<Map<string, Header>> {
    // Convert Map to an Array of values with their keys
    let entries: Array<Map<string, Header>> = new Array<Map<string, Header>>();
    let keys = preheaders.keys();
    for (let i = 0, k = keys.length; i < k; ++i) {
        let key = unchecked(keys[i]);
        let value = preheaders.get(key);
        if (value) {
            let entry = new Map<string, Header>();
            entry.set(key, value);
            entries.push(entry);
        }
    }

    // Sort the array using comparator function
    entries.sort((a: Map<string, Header>, b: Map<string, Header>): i32 => {
        if (a.values()[0].totalDiff > b.values()[0].totalDiff) return 1;
        if (a.values()[0].totalDiff < b.values()[0].totalDiff) return -1;
        return 0;
    });

    return entries;
}

export function serializePreHeaders(preheaders: Map<string, Header>): string {
    let encoder = new JSONEncoder();
    encoder.pushObject(null);

    let keys = preheaders.keys();
    for (let i = 0, k = keys.length; i < k; ++i) {
        let key = unchecked(keys[i]);
        let value = preheaders.get(key);
        if (value !== null) {
            value.stringify(encoder, key);
            encoder.popObject();
        }
    }
    encoder.popObject();
    return encoder.toString();
}

export function serializeHeaderState(headerState: Map<i64, string>): string {
    let encoder = new JSONEncoder();
    encoder.pushObject(null);

    let keys = headerState.keys();
    for (let i = 0, k = keys.length; i < k; ++i) {
        let key = unchecked(keys[i]);
        let value = headerState.get(key);
        if (value !== null) {
            encoder.setString(key.toString(), value);
        }
    }
    encoder.popObject();

    return encoder.toString();
}

export function getValidityDepth(defaultValue: i32): i32 {
    const valDepthString = db.getObject(`validity_depth`);
    if (valDepthString !== "null") {
        return parseInt(valDepthString) as i32;
    } else {
        db.setObject(`validity_depth`, defaultValue.toString());
        return defaultValue;
    }
}

export function setLastDifficultyPeriodParams(defaultValue: DifficultyPeriodParams): void {
    let encoder = new JSONEncoder();
    encoder.pushObject(null);
    encoder.setInteger("startTimestamp", defaultValue.startTimestamp);
    encoder.setInteger("endTimestamp", defaultValue.endTimestamp);
    encoder.setString("difficulty", defaultValue.difficulty.toString());
    encoder.popObject();
    db.setObject(`last_difficulty_period_params`, encoder.toString());
}

export function getLastDifficultyPeriodParams(): DifficultyPeriodParams {
    const valDepthString = db.getObject(`last_difficulty_period_params`);
    if (valDepthString !== "null") {
        const parsed = <JSON.Obj>JSON.parse(valDepthString);
        const difficultyPeriodParams = new DifficultyPeriodParams(
            BigInt.fromString(getStringFromJSON(parsed, 'difficulty')),
            getIntFromJSON(parsed, 'startTimestamp') as i64,
            getIntFromJSON(parsed, 'endTimestamp') as i64
        );
        return difficultyPeriodParams;
    }
    throw new Error('When starting from a block other than 0 you need to provide the lastDifficultyPeriodRetargetBlock');
}

// retarget algo implementation of https://github.com/bitcoin/bitcoin/blob/master/src/pow.cpp#L49
export function retargetAlgorithm(previousTarget: BigInt, firstTimestamp: i64, secondTimestamp: i64): BigInt {
    let elapsedTime: BigInt = BigInt.from((secondTimestamp - firstTimestamp) as i64);
    const rp: BigInt = RETARGET_PERIOD;
    const lowerBound: BigInt = rp.div(4 as i64);
    const upperBound: BigInt = rp.mul(4 as i64);
    // Normalize ratio to factor of 4 if very long or very short
    if (elapsedTime < lowerBound) {
        elapsedTime = lowerBound;
    }
    if (elapsedTime > upperBound) {
        elapsedTime = upperBound;
    }

    let retargetedDiff = previousTarget.mul(elapsedTime).div(rp)

    if (retargetedDiff > MAX_DIFFICULTY)
        retargetedDiff = MAX_DIFFICULTY;

    return retargetedDiff;
}

export function convertHeaderToDifficultyPeriodParams(header: string): DifficultyPeriodParams {
    const decodeHex = Arrays.fromHexString(header);
    const timestamp = extractTimestamp(decodeHex);
    const diffUnformatted = extractTarget(decodeHex);

    return new DifficultyPeriodParams(diffUnformatted, timestamp);
}

// pla: processHeaders only works when you start at block zero, with this function you can start at any arbitrary height, 
// there probably more optimal ways to do this without initializing the preheaders with a block, but this should be sufficient for now
export function initializeAtSpecificBlock(initDataString: string): void {
    const initData = parseInitData(initDataString);

    if (db.getObject(`pre-headers/main`) === "null") {
        getValidityDepth(initData.validityDepth);
        let lastDifficultyPeriodRetargetBlock: string;
        if (initData.lastDifficultyPeriodRetargetBlock !== null) {
            lastDifficultyPeriodRetargetBlock = initData.lastDifficultyPeriodRetargetBlock!;
        } else {
            if (initData.height < RETARGET_PERIOD_BLOCKS) {
                lastDifficultyPeriodRetargetBlock = FIRST_DIFFICULTY_PERIOD_HEADER;
            } else {
                throw new Error('Please supply lastDifficultyPeriodRetargetBlock when you start with a block height higher than the first retarget period');
            }
        }
        setLastDifficultyPeriodParams(convertHeaderToDifficultyPeriodParams(lastDifficultyPeriodRetargetBlock))

        const decodeHex = Arrays.fromHexString(initData.startHeader);
        const prevBlockLE = extractPrevBlockLE(decodeHex);
        const prevBlock = reverseEndianness(prevBlockLE);
        const timestamp = extractTimestamp(decodeHex);
        // pla: maybe merkleRoot does not need to be reversed, came to that conclusion because the library we use for validating proofs for example takes it in the other way
        const merkleRoot = reverseEndianness(extractMerkleRootLE(decodeHex));
        const headerHash = hash256(decodeHex);
        const diff = validateHeaderChain(decodeHex);
        const diffUnformatted = extractTarget(decodeHex);

        const decodedHeader = new Header(
            prevBlock,
            new Date(timestamp * 1000).toISOString(),
            merkleRoot,
            diff,
            diffUnformatted,
            diff.add(initData.previousDifficulty),
            initData.height,
            initData.startHeader
        );

        const preheaders: Map<string, Header> = new Map<string, Header>();
        preheaders.set(Arrays.toHexString(reverseEndianness(headerHash)), decodedHeader);
        db.setObject(`pre-headers/main`, serializePreHeaders(preheaders));

        let key = calcKey(decodedHeader.height);
        let stateForKey = new Map<i64, string>();
        stateForKey.set(decodedHeader.height, initData.startHeader);
        headersState.set(key, stateForKey);

        db.setObject(`headers/${key}`, serializeHeaderState(stateForKey));
    }
}

export function processHeaders(processDataString: string): void {
    const processData = parseProcessData(processDataString);
    const headers: Array<string> = processData.headers;
    const preheaders = getPreheaders();
    const validityDepth = getValidityDepth(DEFAULT_VALIDITY_DEPTH);

    for (let i = 0; i < headers.length; ++i) {
        let rawBH = headers[i];
        const decodeHex = Arrays.fromHexString(rawBH);
        const prevBlockLE = extractPrevBlockLE(decodeHex);
        const prevBlock = reverseEndianness(prevBlockLE);
        const timestamp = extractTimestamp(decodeHex);
        // pla: maybe merkleRoot does not need to be reversed, come to the conclusion because the library we use for validating proofs for example takes it in the other way
        const merkleRoot = reverseEndianness(extractMerkleRootLE(decodeHex));
        const headerHash = hash256(decodeHex);
        const diff = validateHeaderChain(decodeHex);
        const diffUnformatted = extractTarget(decodeHex);

        let prevDiff: BigInt = BigInt.from(0);
        let prevHeight: i32 = 0;

        const prevBlockStr = Arrays.toHexString(prevBlock)
        let continueLoop: bool = true;

        if (prevBlockStr === '0000000000000000000000000000000000000000000000000000000000000000') {
            prevHeight = -1;
            setLastDifficultyPeriodParams(new DifficultyPeriodParams(diffUnformatted, timestamp));
        } else {
            if (preheaders.has(prevBlockStr)) {
                let blockInfo = preheaders.get(prevBlockStr);
                if (blockInfo) {
                    prevDiff = blockInfo.totalDiff;
                    prevHeight = blockInfo.height as i32;
                } else {
                    // pla: because assemblyscript doesnt support 'continue;'
                    continueLoop = false;
                }
            } else {
                // pla: because assemblyscript doesnt support 'continue;'
                continueLoop = false;
            }
        }

        const currentHeight = prevHeight + 1;

        if (continueLoop) {
            const decodedHeader = new Header(
                prevBlock,
                new Date(timestamp * 1000).toISOString(),
                merkleRoot,
                diff,
                diffUnformatted,
                diff.add(prevDiff),
                currentHeight,
                rawBH
            );

            preheaders.set(Arrays.toHexString(reverseEndianness(headerHash)), decodedHeader);
        }
    }
    let sortedPreheaders: Array<Map<string, Header>> = sortPreheadersByTotalDiff(preheaders);

    const topHeader: Uint8Array = Arrays.fromHexString(sortedPreheaders[sortedPreheaders.length - 1].keys()[0]);

    let blocksToPush: Array<Header> = [];
    let curDepth: i32 = 0;
    let prevBlock: Uint8Array | null = null;

    while (true) {
        if (!prevBlock) {
            prevBlock = topHeader;
        }

        let prevBlockStr = Arrays.toHexString(prevBlock);
        if (preheaders.has(prevBlockStr)) {
            let currentHeader = preheaders.get(prevBlockStr);

            // pla: skipping last x blocks below validity_depth            
            if (curDepth >= validityDepth) {
                blocksToPush.push(currentHeader);
            } else {
                curDepth = curDepth + 1;
            }
            prevBlock = currentHeader.prevBlock;
        } else {
            break;
        }
    }

    let lastDifficultyPeriodParams: DifficultyPeriodParams = getLastDifficultyPeriodParams();
    if (lastDifficultyPeriodParams.startTimestamp === 0) {
        throw new Error('lastDifficultyPeriodParams.startTimestamp is not set. This error should never happen.');
    }
    const targetDiffValidatedBlocks: Array<Header> = [];
    for (let i = blocksToPush.length - 1; i >= 0; i--) {
        if (blocksToPush[i].height !== 0) {
            if (blocksToPush[i].height % RETARGET_PERIOD_BLOCKS === RETARGET_PERIOD_BLOCKS - 1) {
                const timestamp = Date.fromString(blocksToPush[i].timestamp).getTime() / 1000;
                lastDifficultyPeriodParams.endTimestamp = timestamp;
                setLastDifficultyPeriodParams(lastDifficultyPeriodParams);
            }
            if (blocksToPush[i].height % RETARGET_PERIOD_BLOCKS === 0) {
                let retargetedDiff = retargetAlgorithm(lastDifficultyPeriodParams.difficulty, lastDifficultyPeriodParams.startTimestamp, lastDifficultyPeriodParams.endTimestamp);
                const currentTimestamp = Date.fromString(blocksToPush[i].timestamp).getTime() / 1000;
                lastDifficultyPeriodParams = new DifficultyPeriodParams(retargetedDiff, currentTimestamp, 0)
                setLastDifficultyPeriodParams(lastDifficultyPeriodParams);
            }
        }
        if (lastDifficultyPeriodParams.difficulty.bitwiseAnd(blocksToPush[i].diffUnformatted).toString() === blocksToPush[i].diffUnformatted.toString()) {
            targetDiffValidatedBlocks.push(blocksToPush[i]);
        }
    }


    let highestHeight = 0;
    for (let i = 0, k = targetDiffValidatedBlocks.length; i < k; ++i) {
        let block = targetDiffValidatedBlocks[i];
        let key = calcKey(block.height);

        //Get headers in memory if not available
        if (!headersState.has(key)) {
            const pulledHeaders = getHeaders(key);
            headersState.set(key, pulledHeaders);
        }

        //Only override if not
        let stateForKey = headersState.get(key);
        if (stateForKey && !stateForKey.has(block.height)) {
            stateForKey.set(block.height, block.raw);
        }

        if (highestHeight < block.height) {
            highestHeight = block.height;
        }
    }

    let preHeaderKeys = preheaders.keys();
    for (let i = 0, k = preHeaderKeys.length; i < k; ++i) {
        let key = unchecked(preHeaderKeys[i]);
        if (headersState.has(key)) {
            let value = preheaders.get(key);
            if (highestHeight >= value.height) {
                preheaders.delete(unchecked(key));
            }
        }
    }

    let headerStateKeys = headersState.keys();
    for (let i = 0, k = headerStateKeys.length; i < k; ++i) {
        let key = unchecked(headerStateKeys[i]);
        if (headersState.has(key)) {
            let val = headersState.get(key);
            const serializedHeaderState = serializeHeaderState(val);
            db.setObject(`headers/${key}`, serializedHeaderState);
        }
    }

    db.setObject(`pre-headers/main`, serializePreHeaders(preheaders));
}

