// Golden rounds: fixed seeds with the SHA-256 of their full tick series.
// The browser determinism check uses the same list.
// Regenerate with tools/gen-golden.ts only after a deliberate spec change.
export const GOLDEN_ROUNDS: readonly { seed: string; roundId: string; hash: string }[] = [
  { seed: "e3c4e0398d936bd3ae4ded9f20c4a72fd99781754062385167f1e4067bc8c1ab", roundId: "golden-0", hash: "9c47f0bc3c0cf8001decf78cdda10326fe431ad330bcbef9a6daa8db0090e3a4" }, // all rugged, 0 graduated
  { seed: "c1fad05c2b891e2a74d051665d438580cb815b482305492c143402d0f57adea2", roundId: "golden-1", hash: "71f590324846c9cf09ba0beb6eb45fabfaa15701fe2b42f85319b7bed2d4d139" }, // all rugged, 0 graduated
  { seed: "1a0820144dcb157500d476d542f1c5768fb175fc783e3fc53065c05debdc2981", roundId: "golden-2", hash: "53bfb3a4928947c3a7a0a97c050b68b4ca4a10ba8aad2ff11e718d1628717316" }, // has a settled coin, 1 graduated
  { seed: "f05a84b87022472b1e51d003c0c1da181feddbb0d00b76ee7440dd63b95c82b2", roundId: "golden-3", hash: "ca05bfdb5fe4193791b31a74521954c4fc8a866cdf87dd6d65566196394cebf0" }, // all rugged, 0 graduated
  { seed: "6adbcc6a96a5646b0b8704d7cd3296045a9523a4a70ea8f61c428544d688b942", roundId: "golden-4", hash: "f99f4237a2ed9fa40300681e15dc3d8e4b61ffbf967e3897f753f4d1cbbda984" }, // all rugged, 0 graduated
  { seed: "681a5bb3ca61c50a673e227c0e459345a9b32e688ca939263fad13fa4f8ac081", roundId: "golden-5", hash: "1254a8cac1bbd329ea5aa03475dd6896ea27725e79b28b2a2bf8f5693dc82bbf" }, // all rugged, 1 graduated
  { seed: "d6a03b6a58c40701091d79eab9e2a3b7dbda3ae842b08c83421088386722c6b1", roundId: "golden-6", hash: "dc7393782fe48879e23f66b14fe91fe1b7bb617197d26f7a4c3b5dbaf86cd7b7" }, // all rugged, 0 graduated
  { seed: "113492f3809c7d00a74a6d9b7a3f081662170f21a929c46ad44e91ed343d0146", roundId: "golden-7", hash: "eed915977c0af37e0ab50a1c4ef6c48b4156dc4733397c011654cd4ef5a216d3" }, // all rugged, 1 graduated
  { seed: "8a358d95b8e4a23e31aba0864af5338ae045907480a5c96aeb189c28820a5e04", roundId: "golden-8", hash: "1a16ec1e09bbf098f50b69beda02678911a721c405ae855e71207eefde417e03" }, // all rugged, 0 graduated
  { seed: "85830dd9fa65cf11dde2ca8d6ac0cc4a3334df477db882e8b3ec623fe356e50f", roundId: "golden-9", hash: "50f4dba2c0f47392ad25dfc975f20d764b50dfb9a9e6197394a40fd8fd3cf740" }, // all rugged, 0 graduated
  { seed: "84732bf3c9758da4f4550c81a85aa8370f80a898224d969975d7588ad71adc0b", roundId: "golden-10", hash: "f49258006ed1b580983917fd51342fa2195d4bf7e6f1464907c9c7fc15c7d5ee" }, // all rugged, 0 graduated
  { seed: "1627620fca6d356d25a686f15a8de4fd071394fa81e46ddfe5aef3fa68198859", roundId: "golden-11", hash: "e270a688b8b337736f2083761c0462d8a7f0359148c66d5d600e1239b239e3ec" }, // all rugged, 1 graduated
  { seed: "6492b73f09a45d2b64ecb3e3dc03aa91dbac13f31d289c30b97026d7e3c18cbe", roundId: "golden-65", hash: "6b97d98da6d3089bd08426f8b64ef368b4f0151c54c3b2a226098de5994e4777" }, // has a settled coin, 1 graduated
  { seed: "11e921f9b5fc0e016a304722486eddb45d57d7acad7ee936e986d5e58b1d4598", roundId: "golden-114", hash: "0735cf8d43787509908ea61945e5101014bb1f8ad940c1c1a196b03d8de0d6c6" }, // has a settled coin, 1 graduated
  { seed: "06045b7d4f82d67b312f525a195f686b3515fc43fb962770ca81622d2b098f23", roundId: "golden-146", hash: "866757db178155072e1a2beea6e78f860b92e68d78a3c5d330cf0136fc5262c7" }, // has a settled coin, 2 graduated
];
