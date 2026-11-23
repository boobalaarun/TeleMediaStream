"""Cross-checks against pyrofork (a Python Telegram library used in production).

  auth <port> <n_hex> <e_hex> <fp_hex>     run pyrofork's real auth-key exchange against the fake server
  client-msg <key_hex> <pkt_hex>           decrypt a client->server message with pyrofork's kdf/aes
  server-msg <key_hex> <session_hex> <salt> <msg_id> <body_hex>
                                           build a server->client message and check it with pyrofork's unpack
"""
import asyncio
import json
import sys
from hashlib import sha1, sha256
from io import BytesIO
from os import urandom
from types import SimpleNamespace

from pyrogram.crypto import aes, mtproto, rsa


def auth(port, n_hex, e_hex, fp_hex):
    import pyrogram.connection.connection as cc
    from pyrogram.connection import Connection
    from pyrogram.connection.transport import TCPIntermediate
    from pyrogram.session.auth import Auth

    cc.DataCenter = lambda *a, **k: ("127.0.0.1", int(port))
    fp = int(fp_hex, 16)
    if fp >= 1 << 63:
        fp -= 1 << 64
    rsa.server_public_keys[fp] = rsa.PublicKey(int(n_hex, 16), int(e_hex, 16))
    client = SimpleNamespace(ipv6=False, alt_port=False, proxy=None,
                             connection_factory=Connection, protocol_factory=TCPIntermediate)
    key = asyncio.run(Auth(client, 2, False).create())
    print(key.hex())


def client_msg(key_hex, pkt_hex):
    key, pkt = bytes.fromhex(key_hex), bytes.fromhex(pkt_hex)
    assert pkt[:8] == sha1(key).digest()[-8:], "auth_key_id"
    msg_key = pkt[8:24]
    k, iv = mtproto.kdf(key, msg_key, True)          # client -> server direction
    plain = aes.ige256_decrypt(pkt[24:], k, iv)
    assert sha256(key[88:120] + plain).digest()[8:24] == msg_key, "msg_key"
    length = int.from_bytes(plain[28:32], "little")
    pad = len(plain) - 32 - length
    assert 12 <= pad <= 1024 and len(plain) % 16 == 0, "padding"
    print(json.dumps({
        "salt": str(int.from_bytes(plain[0:8], "little", signed=True)), "session": plain[8:16].hex(),
        "msg_id": str(int.from_bytes(plain[16:24], "little", signed=True)), "seq_no": int.from_bytes(plain[24:28], "little"),
        "body": plain[32:32 + length].hex(),
    }))


def server_msg(key_hex, session_hex, salt, msg_id, body_hex):
    key, session, body = bytes.fromhex(key_hex), bytes.fromhex(session_hex), bytes.fromhex(body_hex)
    data = (int(salt).to_bytes(8, "little", signed=True) + session + int(msg_id).to_bytes(8, "little", signed=True)
            + (1).to_bytes(4, "little") + len(body).to_bytes(4, "little") + body)
    data += urandom(-(len(data) + 12) % 16 + 12)
    msg_key = sha256(key[96:128] + data).digest()[8:24]
    k, iv = mtproto.kdf(key, msg_key, False)          # server -> client direction
    pkt = sha1(key).digest()[-8:] + msg_key + aes.ige256_encrypt(data, k, iv)
    mtproto.unpack(BytesIO(pkt), session, key, sha1(key).digest()[-8:])   # pyrofork accepts it
    print(pkt.hex())


cmd = sys.argv[1]
{"auth": auth, "client-msg": client_msg, "server-msg": server_msg}[cmd](*sys.argv[2:])
