// node test/abi-test.mjs — the ABI coder against known encodings (the token's constructor from the
// wallet test, ERC-20 calls, dynamic and static arrays), and round trips.
import { encodeMany, encodeCall, decodeMany, show } from '../abi.mjs';
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const word = (h) => h.replace(/^0x/, '').padStart(64, '0'); const str = (s) => { const b = Buffer.from(s); return word(b.length.toString(16)) + b.toString('hex').padEnd(64, '0'); };
t('the token constructor (string,string,uint8,uint256) matches the hand encoding', encodeMany(['string', 'string', 'uint8', 'uint256'], ['Shell Token', 'SHELL', '2', '100000000']) === word('80') + word('c0') + word('2') + word((100000000n).toString(16)) + str('Shell Token') + str('SHELL'));
t('balanceOf(address)', encodeCall('0x70a08231', ['address'], ['0x7777777777777777777777777777777777777777']) === '0x70a08231' + '77'.repeat(20).padStart(64, '0'));
t('transfer(address,uint256)', encodeCall('0xa9059cbb', ['address', 'uint256'], ['0x' + '11'.repeat(20), 1250n]) === '0xa9059cbb' + '11'.repeat(20).padStart(64, '0') + word('4e2'));
t('a negative int256 is two\'s complement', encodeMany(['int256'], ['-1']) === 'f'.repeat(64));
t('bool and bytes32', encodeMany(['bool', 'bytes32'], ['true', '0x' + 'ab'.repeat(32)]) === word('1') + 'ab'.repeat(32));
t('a dynamic uint256[] puts an offset in the head', encodeMany(['uint256[]'], [[1, 2, 3]]) === word('20') + word('3') + word('1') + word('2') + word('3'));
t('a fixed address[2] is inline', encodeMany(['address[2]'], ['0x' + '11'.repeat(20) + ',0x' + '22'.repeat(20)]) === '11'.repeat(20).padStart(64, '0') + '22'.repeat(20).padStart(64, '0'));
t('a string list from the page (comma separated) encodes as string[]', encodeMany(['string[]'], ['a,bb']).startsWith(word('20') + word('2') + word('40') + word('80')));
const rt = (types, values) => decodeMany(types, encodeMany(types, values));
t('round trip: uint, address, bool, string, bytes', show(rt(['uint256', 'address', 'bool', 'string', 'bytes'], ['42', '0x' + 'ab'.repeat(20), 'false', 'hello', '0x0102'])) === '[42, 0x' + 'ab'.repeat(20) + ', false, hello, 0x0102]');
t('round trip: arrays', show(rt(['uint8[]', 'bytes32[1]', 'string[]'], [[7, 8], ['0x' + '00'.repeat(32)], ['x', 'yz']])) === '[[7, 8], [0x' + '00'.repeat(32) + '], [x, yz]]');
t('decode a revert reason payload (string after the selector)', decodeMany(['string'], '0x' + word('20') + str('balance'))[0] === 'balance');
t('decode int256 -5', decodeMany(['int256'], 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb')[0] === -5n);
let threw = false; try { encodeMany(['address'], ['0x123']); } catch { threw = true; } t('a bad address is refused', threw);
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
