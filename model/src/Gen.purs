-- | Random lines of text holding one formula, for the laws (test/) and for
-- | checking the editor against the model (test/model-diff.mjs).
module Gen where

import Prelude hiding (sub)

import Data.Array as A
import Data.Array.NonEmpty as NEA
import Data.Tuple (Tuple(..))
import Model (Box, Item, ch, chars, math, struct, sub, sup, sym)
import Random.LCG (mkSeed)
import Test.QuickCheck.Gen (Gen, chooseInt, elements, frequency, sample, sized, resize)

-- | A line: some text, the formula, some text.
genLine :: Gen Box
genLine = do
  f <- sized \n -> resize (min n 3) genBox
  pure (chars "前 " <> [ math f ] <> chars " 後")

genBox :: Gen Box
genBox = sized \depth -> do
  n <- chooseInt 0 5
  A.concat <$> sequence (A.replicate n (genPiece depth))
  where
  sequence = A.foldr (\g acc -> A.cons <$> g <*> acc) (pure [])

-- | A few items that belong together (a base and its scripts, a bracketed
-- | group), so parentheses always come in pairs.
genPiece :: Int -> Gen Box
genPiece depth = frequency $ NEA.cons'
  (Tuple 6.0 (pure <$> genAtom))
  ( [ Tuple 2.0 (pure <$> elements (NEA.cons' (ch '+') [ ch '-', ch '=', sym "to" "rel", sym "cdot" "bin" ])) ]
      <> if depth <= 0 then [] else
        [ Tuple 1.0 ((\a b -> [ struct "frac" [ a, b ] ]) <$> inner <*> inner)
        , Tuple 1.0 ((\a -> [ struct "sqrt" [ a ] ]) <$> inner)
        , Tuple 1.0 ((\a -> [ struct "overset" [ a, [ sym "to" "rel" ] ] ]) <$> inner)
        , Tuple 1.0 ((\b s -> [ b, sup s ]) <$> genAtom <*> inner)
        , Tuple 1.0 ((\b s -> [ b, sub s ]) <$> genAtom <*> inner)
        , Tuple 1.0 ((\b s t -> [ b, sup s, sub t ]) <$> genAtom <*> inner <*> inner)
        , Tuple 1.0 ((\b s t -> [ b, sub s, sup t ]) <$> genAtom <*> inner <*> inner)
        , Tuple 1.0 ((\a -> [ ch '(' ] <> a <> [ ch ')' ]) <$> inner)
        , Tuple 0.5 ((\a b -> a <> [ ch '/' ] <> b) <$> inner <*> inner)
        ]
  )
  where
  inner = resize (depth - 1) genBox

genAtom :: Gen Item
genAtom = elements (NEA.cons' (ch 'a') [ ch 'b', ch 'x', ch 'M', ch 'N', ch '1', ch '2', sym "alpha" "ord", sym "pi" "ord" ])

-- | n lines from a fixed seed, for the JavaScript side.
samples :: Int -> Int -> Array Box
samples seed n = sample (mkSeed seed) n genLine
