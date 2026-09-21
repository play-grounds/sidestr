// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.20;

/// One trade between two keys that need not trust each other. The payer locks value naming a payee,
/// a hash and a deadline: before the deadline only the preimage releases it, and only to the payee;
/// after the deadline only the payer can take it back. No arbiter, no owner, no way to upgrade this.
/// The hash is sha256, not keccak256, so the same secret unlocks a Bitcoin-style HTLC on the sats
/// side of a sidestr chain.
contract Escrow {
    struct Lock { address payer; uint64 deadline; address payee; uint256 amount; bytes32 hash; }
    mapping(bytes32 => Lock) public locks;                       // payer and deadline share one slot

    event Locked(bytes32 indexed id, address indexed payer, address indexed payee, uint256 amount, uint64 deadline, bytes32 hash);
    event Claimed(bytes32 indexed id, bytes32 preimage);
    event Refunded(bytes32 indexed id);

    /// The id of a lock is what it says it is, so the payer knows it before sending anything and
    /// nobody else can occupy it: payer is msg.sender in lock() and cannot be forged.
    function idOf(address payer, address payee, bytes32 h, uint64 deadline) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, payee, h, deadline));
    }

    function lock(address payee, bytes32 h, uint64 deadline) external payable returns (bytes32 id) {
        require(msg.value > 0, "empty");
        require(payee != address(0), "nobody");
        require(deadline > block.timestamp, "past");
        id = idOf(msg.sender, payee, h, deadline);
        require(locks[id].payer == address(0), "taken");
        locks[id] = Lock(msg.sender, deadline, payee, msg.value, h);
        emit Locked(id, msg.sender, payee, msg.value, deadline, h);
    }

    /// Anyone may submit this: the secret is the authorisation, not the sender, and the money goes
    /// to the payee the lock names whoever pays the gas.
    function claim(bytes32 id, bytes32 preimage) external {
        Lock memory l = locks[id];
        require(l.payer != address(0), "gone");
        require(block.timestamp < l.deadline, "late");
        require(sha256(abi.encodePacked(preimage)) == l.hash, "hash");
        delete locks[id];                                        // delete before paying: the callee
        emit Claimed(id, preimage);                              // runs after the lock is gone
        (bool paid, ) = l.payee.call{value: l.amount}(""); require(paid, "payee");
    }

    function refund(bytes32 id) external {
        Lock memory l = locks[id];
        require(l.payer != address(0), "gone");
        require(block.timestamp >= l.deadline, "early");         // the claim window and this one
        delete locks[id];                                        // can never both be open
        emit Refunded(id);
        (bool paid, ) = l.payer.call{value: l.amount}(""); require(paid, "payer");
    }
}
