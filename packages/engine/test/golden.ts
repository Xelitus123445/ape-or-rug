// Golden rounds: fixed seeds with the SHA-256 of their full tick series.
// The browser determinism check uses the same list.
// Regenerate with tools/gen-golden.ts only after a deliberate spec change.
export const GOLDEN_ROUNDS: readonly { seed: string; roundId: string; hash: string }[] = [
  { seed: "e3c4e0398d936bd3ae4ded9f20c4a72fd99781754062385167f1e4067bc8c1ab", roundId: "golden-0", hash: "7f6b1da789d52cb739d40852b959dd22bd262c1ccb71442486998a71a4798ff5" },
  { seed: "c1fad05c2b891e2a74d051665d438580cb815b482305492c143402d0f57adea2", roundId: "golden-1", hash: "ea5bd9da18169811eaf31d014ee15a47022a2b421155e908aabd003b343acdf0" },
  { seed: "1a0820144dcb157500d476d542f1c5768fb175fc783e3fc53065c05debdc2981", roundId: "golden-2", hash: "3c5a2e5a9597e99411061a1a03c1747a9306407b7aeba7993144f1595e39424b" },
  { seed: "f05a84b87022472b1e51d003c0c1da181feddbb0d00b76ee7440dd63b95c82b2", roundId: "golden-3", hash: "42f5ef7c783b44795632c2aed10b697bc5439601578fafa97a02c6d8eaf1faa4" },
  { seed: "6adbcc6a96a5646b0b8704d7cd3296045a9523a4a70ea8f61c428544d688b942", roundId: "golden-4", hash: "7f87d3eb5041b4a11d0cc154126d613e49193afcf99795c097b52c278422449d" },
  { seed: "681a5bb3ca61c50a673e227c0e459345a9b32e688ca939263fad13fa4f8ac081", roundId: "golden-5", hash: "ba6a752f5b7e22faf07f1576e35d2757731a3bd45003a8f72662e8a037485d5f" },
  { seed: "d6a03b6a58c40701091d79eab9e2a3b7dbda3ae842b08c83421088386722c6b1", roundId: "golden-6", hash: "dce6337b097e16699cf63562fc8e72919efdc5bae87f8e17ec4eb9b8401dfd03" },
  { seed: "113492f3809c7d00a74a6d9b7a3f081662170f21a929c46ad44e91ed343d0146", roundId: "golden-7", hash: "fd6aace773fe1868a95024cfe12eb4319848895afe72006dd7a55eb4e4d6efd6" },
  { seed: "8a358d95b8e4a23e31aba0864af5338ae045907480a5c96aeb189c28820a5e04", roundId: "golden-8", hash: "81dccc4d4d73bc781f2b8c260ca8291cfb45da2f14228ec3173fa99a2434dbbf" },
  { seed: "85830dd9fa65cf11dde2ca8d6ac0cc4a3334df477db882e8b3ec623fe356e50f", roundId: "golden-9", hash: "64ded0a3f0e244d3182e500b8098a9866b409e09c37d970cc8d67f506d44bb78" },
  { seed: "84732bf3c9758da4f4550c81a85aa8370f80a898224d969975d7588ad71adc0b", roundId: "golden-10", hash: "096343b364bf6ae38879dc6a2ae7db3b45c98adceb768cd63063553ed136d8e1" },
  { seed: "1627620fca6d356d25a686f15a8de4fd071394fa81e46ddfe5aef3fa68198859", roundId: "golden-11", hash: "481a28e2df4695d87f422e0cd976d52b19989989ca92f4cc683db9ffc2366346" },
];
