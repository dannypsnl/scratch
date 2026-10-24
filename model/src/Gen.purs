-- | Random lines of text holding one formula, for the laws (test/), for
-- | checking the editor against the model (test/model-diff.mjs) and for the
-- | fuzzer (test/fuzz.mjs). Odd combinations on purpose: every kind of
-- | structure, empty slots, structures in scripts in labels, scripts after
-- | structures, a script with no base, two of the same script in a row,
-- | stacked pairs both ways, lone parentheses, \text with spaces.
module Gen where

import Prelude hiding (sub)

import Data.Array as A
import Data.Array.NonEmpty as NEA
import Data.Tuple (Tuple(..))
import Model (Box, Item, ch, chars, math, struct, sub, sup, sym)
import Random.LCG (mkSeed)
import Test.QuickCheck.Gen (Gen, chooseInt, elements, frequency, sample, sized, resize, vectorOf)

-- | A line: some text, the formula, some text.
genLine :: Gen Box
genLine = do
  f <- sized \n -> resize (min n 4) genBox
  pure (chars "前 " <> [ math f ] <> chars " 後")

genBox :: Gen Box
genBox = sized \depth -> do
  -- empty and short boxes often: that is where the edges are
  n <- frequency $ NEA.cons' (Tuple 2.0 (pure 0)) [ Tuple 3.0 (chooseInt 1 2), Tuple 3.0 (chooseInt 3 6) ]
  A.concat <$> vectorOf n (genPiece depth)

-- | A few items that belong together.
genPiece :: Int -> Gen Box
genPiece depth = frequency $ NEA.cons'
  (Tuple 6.0 (pure <$> genAtom))
  ( [ Tuple 3.0 (pure <$> genOperator)
    , Tuple 0.5 (pure <$> elements (NEA.cons' (ch '(') [ ch ')', ch '/', ch '|', ch '.' ])) -- alone, unbalanced
    ]
      <> if depth <= 0 then [] else
        [ Tuple 4.0 (pure <$> genStruct depth)
        , Tuple 1.0 ((\b s -> [ b, sup s ]) <$> genBase <*> inner)
        , Tuple 1.0 ((\b s -> [ b, sub s ]) <$> genBase <*> inner)
        , Tuple 1.0 ((\b s t -> [ b, sup s, sub t ]) <$> genBase <*> inner <*> inner)
        , Tuple 1.0 ((\b s t -> [ b, sub s, sup t ]) <$> genBase <*> inner <*> inner)
        , Tuple 0.5 ((\b s t -> [ b, sup s, sup t ]) <$> genBase <*> inner <*> inner) -- x^a^b
        , Tuple 0.3 ((\s -> [ sup s ]) <$> inner) -- no base
        , Tuple 0.3 ((\s -> [ sub s ]) <$> inner)
        , Tuple 1.0 ((\a -> [ ch '(' ] <> a <> [ ch ')' ]) <$> inner)
        , Tuple 0.7 ((\a b -> a <> [ ch '/' ] <> b) <$> inner <*> inner)
        ]
  )
  where
  inner = resize (depth - 1) genBox
  -- what a script sits on: a letter, or a whole structure (\frac{a}{b}^2)
  genBase = frequency $ NEA.cons' (Tuple 4.0 genAtom) [ Tuple 1.0 (genStruct depth) ]

genAtom :: Gen Item
genAtom = elements $ NEA.cons' (ch 'a')
  [ ch 'b', ch 'x', ch 'y', ch 'M', ch 'N', ch '0', ch '1', ch '2'
  , sym "alpha" "ord", sym "pi" "ord", sym "infty" "ord", sym "aleph" "ord", sym "partial" "ord", sym "ell" "ord"
  , sym "sum" "op", sym "int" "op", sym "bigcup" "op"
  , sym "sin" "opname", sym "lim" "opname"
  , sym "quad" "ord", sym "," "ord"
  ]

genOperator :: Gen Item
genOperator = elements $ NEA.cons' (ch '+')
  [ ch '-', ch '=', ch '<', ch ',', ch '*'
  , sym "to" "rel", sym "leftarrow" "rel", sym "mapsto" "rel", sym "leq" "rel", sym "in" "rel", sym "subseteq" "rel", sym "iff" "rel", sym "mid" "rel"
  , sym "cdot" "bin", sym "times" "bin", sym "oplus" "bin", sym "land" "bin", sym "setminus" "bin"
  ]

genStruct :: Int -> Gen Item
genStruct depth = frequency $ NEA.cons'
  (Tuple 2.0 (two "frac"))
  [ Tuple 0.5 (two "dfrac"), Tuple 0.5 (two "tfrac"), Tuple 0.5 (two "binom")
  , Tuple 1.5 (one "sqrt")
  , Tuple 1.5 ((\a b -> struct "overset" [ a, b ]) <$> inner <*> genArrowBase)
  , Tuple 0.7 ((\a b -> struct "stackrel" [ a, b ]) <$> inner <*> genArrowBase)
  , Tuple 0.7 (two "underset")
  , Tuple 0.5 (one "overline"), Tuple 0.5 (one "underline"), Tuple 0.5 (one "boxed")
  , Tuple 0.5 (one "hat"), Tuple 0.5 (one "vec"), Tuple 0.5 (one "widehat"), Tuple 0.5 (one "overrightarrow")
  , Tuple 0.7 (one "left("), Tuple 0.3 (one "left|") -- \left( … \right)
  , Tuple 0.5 (one "mathbf"), Tuple 0.5 (one "mathrm")
  , Tuple 0.5 ((\l -> struct "mathbb" [ [ l ] ]) <$> elements (NEA.cons' (ch 'R') [ ch 'Z', ch 'N' ]))
  , Tuple 0.7 ((\t -> struct "text" [ chars t ]) <$> elements (NEA.cons' "if" [ "for all", " a b ", "", "x y" ]))
  , Tuple 0.5 ((\k slots -> struct "foo" (A.take k slots)) <$> chooseInt 1 3 <*> vectorOf 3 inner) -- a command not known
  ]
  where
  inner = resize (depth - 1) genBox
  one name = (\a -> struct name [ a ]) <$> inner
  two name = (\a b -> struct name [ a, b ]) <$> inner <*> inner
  -- under a label: mostly a lone arrow (drawn stretched, written \xrightarrow), sometimes not
  genArrowBase = frequency $ NEA.cons'
    (Tuple 4.0 ((\a -> [ a ]) <$> elements (NEA.cons' (sym "to" "rel") [ sym "leftarrow" "rel", sym "mapsto" "rel", sym "twoheadrightarrow" "rel", sym "rightarrow" "rel" ])))
    [ Tuple 1.0 ((\a -> [ a ]) <$> elements (NEA.cons' (ch '=') [ sym "leq" "rel", ch 'x' ])), Tuple 1.0 inner ]

-- | n lines from a fixed seed, for the JavaScript side.
samples :: Int -> Int -> Array Box
samples seed n = sample (mkSeed seed) n genLine
