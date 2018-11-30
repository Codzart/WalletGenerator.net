var ninja = {
	wallets: {}
};

ninja.privateKey = {
	isPrivateKey: function (key) {
		try {
			// WIF/CWIF
			wif.decode(key);
			return true;
		} catch (e) {}
		var testValue = function (buffer) {
			if (buffer.length != 32)
				return false;
			var n = elliptic.curves.secp256k1.curve.n;
			var scalar = bigi.fromByteArrayUnsigned(buffer);
			return n.compareTo(scalar) > 0;
		}
		// TODO: support mini key
		return testValue(Buffer.from(key, 'hex')) || testValue(Buffer.from(key, 'base64'));
	},
	getECKeyFromAdding: function (privKey1, privKey2) {
		var n = elliptic.curves.secp256k1.curve.n;
		var ecKey1 = bitcoin.ECKey.fromWIF(privKey1, janin.selectedCurrency);
		var ecKey2 = bitcoin.ECKey.fromWIF(privKey2, janin.selectedCurrency);
		// if both keys are the same return null
		if (ecKey1.d.eq(ecKey2.d)) return null;
		var combinedPrivateKey = new bitcoin.ECKey(ecKey1.d.add(ecKey2.d).mod(n), null, {
			network: janin.selectedCurrency,
			compressed: ecKey1.compressed && ecKey2.compressed
		});
		return combinedPrivateKey;
	},
	getECKeyFromMultiplying: function (privKey1, privKey2) {
		var n = elliptic.curves.secp256k1.curve.n;
		var ecKey1 = bitcoin.ECKey.fromWIF(privKey1, janin.selectedCurrency);
		var ecKey2 = bitcoin.ECKey.fromWIF(privKey2, janin.selectedCurrency);
		// if both keys are the same return null
		if (ecKey1.d.eq(ecKey2.d)) return null;
		var combinedPrivateKey = new bitcoin.ECKey(ecKey1.d.mul(ecKey2.d).mod(n), null, {
			network: janin.selectedCurrency,
			compressed: ecKey1.compressed && ecKey2.compressed
		});
		return combinedPrivateKey;
	},
	// 58 base58 characters starting with 6P
	isBIP38Format: function (key) {
		key = key.toString();
		return (/^6P[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{56}$/.test(key));
	},
	BIP38EncryptedKeyToByteArrayAsync: function (base58Encrypted, passphrase, callback) {
		// we're decrypting BIP38-encryped key
		try {
			var decryptedKey = bip38.decrypt(base58Encrypted, passphrase, function (status) {
				console.log(status.percent);
			});
			callback(wif.encode(janin.selectedCurrency.wif, decryptedKey.privateKey, decryptedKey.compressed));
		} catch (e) {
			callback(new Error(ninja.translator.get("detailalertnotvalidprivatekey")));
		}
	},
	BIP38PrivateKeyToEncryptedKeyAsync: function (base58Key, passphrase, compressed, callback) {
		// encrypt
		var decoded = wif.decode(base58Key)
		var encryptedKey = bip38.encrypt(decoded.privateKey, compressed, passphrase);
		callback(encryptedKey);
	},
	BIP38GenerateIntermediatePointAsync: function (passphrase, lotNum, sequenceNum, callback) {
		var noNumbers = lotNum === null || sequenceNum === null;
		var ownerEntropy, ownerSalt;

		if (noNumbers) {
			ownerSalt = ownerEntropy = randombytes(8);
		} else {
			// 1) generate 4 random bytes
			ownerSalt = randombytes(4);

			// 2)  Encode the lot and sequence numbers as a 4 byte quantity (big-endian):
			// lotnumber * 4096 + sequencenumber. Call these four bytes lotsequence.
			var lotSequence = new bigi(4096 * lotNum + sequenceNum).toByteArrayUnsigned();

			// 3) Concatenate ownersalt + lotsequence and call this ownerentropy.
			ownerEntropy = ownerSalt.concat(lotSequence);
		}


		// 4) Derive a key from the passphrase using scrypt
		var prefactor = scrypt(passphrase, ownerSalt, 16384, 8, 8, 32);
		// Take SHA256(SHA256(prefactor + ownerentropy)) and call this passfactor
		var passfactorBytes = noNumbers ? prefactor : bitcoin.crypto.hash256(prefactor.concat(ownerEntropy));
		var passfactor = new bnjs(passfactorBytes);

		// 5) Compute the elliptic curve point G * passfactor, and convert the result to compressed notation (33 bytes)
		var ellipticCurve = elliptic.curves.secp256k1.curve;
		var passpoint = ellipticCurve.g.mul(passfactor).encodeCompressed();

		// 6) Convey ownersalt and passpoint to the party generating the keys, along with a checksum to ensure integrity.
		// magic bytes "2C E9 B3 E1 FF 39 E2 51" followed by ownerentropy, and then passpoint
		var magicBytes = [0x2C, 0xE9, 0xB3, 0xE1, 0xFF, 0x39, 0xE2, 0x51];
		if (noNumbers) magicBytes[7] = 0x53;

		var intermediate = magicBytes.concat(ownerEntropy).concat(passpoint);

		// base58check encode
		intermediate = intermediate.concat(bitcoin.crypto.hash256(intermediate).slice(0, 4));
		callback(base58.encode(intermediate));
	},
	BIP38GenerateECAddressAsync: function (intermediate, compressed, callback) {
		// decode IPS
		var x = base58.decode(intermediate);
		//if(x.slice(49, 4) !== bitcoin.crypto.hash256(x.slice(0,49)).slice(0,4)) {
		//	callback({error: 'Invalid intermediate passphrase string'});
		//}
		var noNumbers = (x[7] === 0x53);
		var ownerEntropy = x.slice(8, 8 + 8);
		var passpoint = x.slice(16, 16 + 33);

		// 1) Set flagbyte.
		// set bit 0x20 for compressed key
		// set bit 0x04 if ownerentropy contains a value for lotsequence
		var flagByte = (compressed ? 0x20 : 0x00) | (noNumbers ? 0x00 : 0x04);


		// 2) Generate 24 random bytes, call this seedb.
		var seedB = randombytes(24);

		// Take SHA256(SHA256(seedb)) to yield 32 bytes, call this factorb.
		var factorB = bitcoin.crypto.hash256(seedB);

		// 3) ECMultiply passpoint by factorb. Use the resulting EC point as a public key and hash it into a Bitcoin
		// address using either compressed or uncompressed public key methodology (specify which methodology is used
		// inside flagbyte). This is the generated Bitcoin address, call it generatedaddress.
		var ellipticCurve = elliptic.curves.secp256k1.curve;
		var generatedPoint = ellipticCurve.decodePoint(Buffer.from(passpoint));
		var generatedBytes = generatedPoint.mul(new bnjs(factorB)).getEncoded(compressed);
		var generatedAddress = bitcoin.address.toBase58Check(bitcoin.crypto.hash160(generatedBytes), 0);

		// 4) Take the first four bytes of SHA256(SHA256(generatedaddress)) and call it addresshash.
		var addressHash = bitcoin.crypto.hash256(generatedAddress).slice(0, 4);

		// 5) Now we will encrypt seedb. Derive a second key from passpoint using scrypt
		var derivedBytes = scrypt(passpoint, addressHash.concat(ownerEntropy), 1024, 1, 1, 64);
		// 6) Do AES256Encrypt(seedb[0...15]] xor derivedhalf1[0...15], derivedhalf2), call the 16-byte result encryptedpart1
		for (var i = 0; i < 16; ++i) {
			seedB[i] ^= derivedBytes[i];
		}
		var decipher1 = aes.createDecipher('aes-256-ecb', derivedBytes.slice(32))
		decipher1.setAutoPadding(false);
		decipher1.end(encryptedPart2);
		var encryptedPart1 = decipher1.read();

		// 7) Do AES256Encrypt((encryptedpart1[8...15] + seedb[16...23]) xor derivedhalf1[16...31], derivedhalf2), call the 16-byte result encryptedseedb.
		var message2 = encryptedPart1.slice(8, 8 + 8).concat(seedB.slice(16, 16 + 8));
		for (var i = 0; i < 16; ++i) {
			message2[i] ^= derivedBytes[i + 16];
		}
		var decipher2 = aes.createDecipheriv('aes-256-ecb', derivedBytes.slice(32))
		decipher2.setAutoPadding(false);
		decipher2.end(message2);
		var encryptedSeedB = decipher2.read();

		// 0x01 0x43 + flagbyte + addresshash + ownerentropy + encryptedpart1[0...7] + encryptedpart2
		var encryptedKey = [0x01, 0x43, flagByte].concat(addressHash).concat(ownerEntropy).concat(encryptedPart1.slice(0, 8)).concat(encryptedSeedB);

		// base58check encode
		encryptedKey = encryptedKey.concat(bitcoin.crypto.hash256(encryptedKey).slice(0, 4));
		callback(generatedAddress, base58.encode(encryptedKey));

	}
};

ninja.publicKey = {
	isPublicKeyHexFormat: function (key) {
		key = key.toString();
		return ninja.publicKey.isUncompressedPublicKeyHexFormat(key) || ninja.publicKey.isCompressedPublicKeyHexFormat(key);
	},
	// 130 characters [0-9A-F] starts with 04
	isUncompressedPublicKeyHexFormat: function (key) {
		key = key.toString();
		return /^04[A-Fa-f0-9]{128}$/.test(key);
	},
	// 66 characters [0-9A-F] starts with 02 or 03
	isCompressedPublicKeyHexFormat: function (key) {
		key = key.toString();
		return /^0[23][A-Fa-f0-9]{64}$/.test(key);
	},
	getBitcoinAddressFromByteArray: function (pubKeyByteArray) {
		var pubKeyHash = bitcoin.crypto.hash160(pubKeyByteArray);
		return bitcoin.address.toBase58Check(pubKeyHash, 0);
	},
	getHexFromByteArray: function (pubKeyByteArray) {
		return Buffer.from(pubKeyByteArray).toString("hex").toUpperCase();
	},
	getByteArrayFromAdding: function (pubKeyHex1, pubKeyHex2) {
		var curve = elliptic.curves.secp256k1;
		var ecPoint1 = curve.decodePoint(Buffer.from(pubKeyHex1, "hex"));
		var ecPoint2 = curve.decodePoint(Buffer.from(pubKeyHex2, "hex"));
		// if both points are the same return null
		if (ecPoint1.eq(ecPoint2)) return null;
		var compressed = (ecPoint1.compressed && ecPoint2.compressed);
		var pubKey = ecPoint1.add(ecPoint2).getEncoded(compressed);
		return pubKey;
	},
	getByteArrayFromMultiplying: function (pubKeyHex, ecKey) {
		var ecPoint = elliptic.curves.secp256k1.decodePoint(Buffer.from(pubKeyHex, "hex"));
		var compressed = (ecPoint.compressed && ecKey.compressed);
		// if both points are the same return null
		ecKey.compressed = false;
		if (ecPoint.eq(ecKey.Q)) {
			return null;
		}
		var bigInt = ecKey.d;
		var pubKey = ecPoint.mul(bigInt).encoded("buffer", compressed);
		return pubKey;
	},
	// used by unit test
	getDecompressedPubKeyHex: function (pubKeyHexComp) {
		var ecPoint = elliptic.curves.secp256k1.decodePoint(Buffer.from(pubKeyHexComp, "hex"));
		var pubByteArray = ecPoint.encoded("buffer", 0);
		var pubHexUncompressed = ninja.publicKey.getHexFromByteArray(pubByteArray);
		return pubHexUncompressed;
	}
};