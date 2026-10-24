-- | The formula editor's behaviour as plain functions: what the caret and
-- | the selection do on each key, and what each rewrite of a selection gives.
-- | This is the specification; the editor (src/nav.js, src/notation.js) is
-- | checked against it, never the other way round.
module Model where

import Prelude hiding (sub)

import Data.Array as A
import Data.Foldable (all, elem, foldMap)
import Data.Maybe (Maybe(..), fromMaybe, isJust, maybe)
import Data.String.CodeUnits as SCU

-- | One thing in a container, as a plain record so JavaScript reads it as is.
-- | kind "ch": a character (name); "sym": a symbol command (name) of class
-- | cls ("rel", "bin", "ord", …); "struct": a command (name) with argument
-- | slots; "sup" / "sub": a script (one slot); "math": a formula sitting in a
-- | line of text (one slot).
newtype Item = Item { kind :: String, name :: String, cls :: String, slots :: Array (Array Item) }

instance Eq Item where
  eq (Item a) (Item b) = a.kind == b.kind && a.name == b.name && a.cls == b.cls && a.slots == b.slots

instance Show Item where
  show (Item i) = case i.kind of
    "ch" -> i.name
    "sym" -> "\\" <> i.name <> " "
    "sup" -> "^{" <> showBox (slot 0) <> "}"
    "sub" -> "_{" <> showBox (slot 0) <> "}"
    "math" -> "$" <> showBox (slot 0) <> "$"
    _ -> "\\" <> i.name <> foldMap (\s -> "{" <> showBox s <> "}") i.slots
    where
    slot k = fromMaybe [] (A.index i.slots k)

type Box = Array Item

showBox :: Box -> String
showBox = foldMap show

ch :: Char -> Item
ch c = Item { kind: "ch", name: SCU.singleton c, cls: "", slots: [] }

sym :: String -> String -> Item
sym name cls = Item { kind: "sym", name, cls, slots: [] }

struct :: String -> Array Box -> Item
struct name slots = Item { kind: "struct", name, cls: "", slots }

sup :: Box -> Item
sup b = Item { kind: "sup", name: "", cls: "", slots: [ b ] }

sub :: Box -> Item
sub b = Item { kind: "sub", name: "", cls: "", slots: [ b ] }

math :: Box -> Item
math b = Item { kind: "math", name: "", cls: "", slots: [ b ] }

chars :: String -> Box
chars = map ch <<< SCU.toCharArray

kind :: Item -> String
kind (Item i) = i.kind

nameOf :: Item -> String
nameOf (Item i) = i.name

slotsOf :: Item -> Array Box
slotsOf (Item i) = i.slots

isScript :: Item -> Boolean
isScript it = kind it == "sup" || kind it == "sub"

-- | Items the caret goes into rather than over.
hasSlots :: Item -> Boolean
hasSlots it = not (A.null (slotsOf it))

-- ---------------------------------------------------------------------------
-- Positions

-- | The caret: the items entered from the line down (index in the container,
-- | then which slot), and the offset in the innermost container.
type Step = { item :: Int, slot :: Int }
type Pos = { path :: Array Step, off :: Int }
type Sel = { anchor :: Pos, head :: Pos }

containerAt :: Box -> Array Step -> Maybe Box
containerAt box path = case A.uncons path of
  Nothing -> Just box
  Just { head: s, tail } -> do
    it <- A.index box s.item
    inner <- A.index (slotsOf it) s.slot
    containerAt inner tail

inFormula :: Pos -> Boolean
inFormula p = not (A.null p.path)

-- | Stacked scripts: x^2_i draws 2 over i. Pairs are taken greedily from the
-- | left, so x_a^b_c pairs _a with ^b and leaves _c alone.
partner :: Box -> Int -> Maybe Int
partner box i = go 0
  where
  go j = case A.index box j, A.index box (j + 1) of
    Just a, Just b
      | isScript a && isScript b && kind a /= kind b ->
          if i == j then Just (j + 1) else if i == j + 1 then Just j else go (j + 2)
    _, Just _ -> go (j + 1)
    _, _ -> Nothing

-- | Between the two scripts of a pair: drawn at the same spot as the start
-- | of the pair, so not a place the caret rests.
betweenPair :: Box -> Int -> Boolean
betweenPair box off = off > 0 && partner box (off - 1) == Just off

-- | Every place the caret may rest in the line: inside the formula, and the
-- | text positions right beside it.
stops :: Box -> Array Pos
stops line = A.concat (A.mapWithIndex (\i it -> if kind it == "math" then beside i <> inside [ { item: i, slot: 0 } ] (fromMaybe [] (A.index (slotsOf it) 0)) else []) line)
  where
  beside i = [ { path: [], off: i }, { path: [], off: i + 1 } ]
  inside path box =
    map (\off -> { path, off }) (A.filter (not <<< betweenPair box) (A.range 0 (A.length box)))
      <> A.concat (A.mapWithIndex (\i it -> A.concat (A.mapWithIndex (\k s -> inside (A.snoc path { item: i, slot: k }) s) (slotsOf it))) box)

-- | Document order.
before :: Pos -> Pos -> Boolean
before a b = go 0
  where
  go d = case A.index a.path d, A.index b.path d of
    Just x, Just y
      | x.item /= y.item -> x.item < y.item
      | x.slot /= y.slot -> x.slot < y.slot
      | otherwise -> go (d + 1)
    Just x, Nothing -> x.item < b.off
    Nothing, Just y -> a.off <= y.item
    Nothing, Nothing -> a.off < b.off

-- ---------------------------------------------------------------------------
-- Left / Right

-- | One step right: over a character or symbol, into a structure's first
-- | slot or a script, on to the next slot, from the first script of a pair
-- | into the second, out after a structure. Nothing past the line's end.
right :: Box -> Pos -> Maybe Pos
right line p = do
  box <- containerAt line p.path
  case A.index box p.off of
    Just it | hasSlots it -> Just { path: A.snoc p.path { item: p.off, slot: 0 }, off: 0 }
    Just _ -> Just p { off = p.off + 1 }
    Nothing -> do
      { init, last } <- A.unsnoc p.path
      outer <- containerAt line init
      it <- A.index outer last.item
      if last.slot < A.length (slotsOf it) - 1 then Just { path: A.snoc init last { slot = last.slot + 1 }, off: 0 }
      else case partner outer last.item of
        Just j | isScript it && j == last.item + 1 -> Just { path: A.snoc init { item: j, slot: 0 }, off: 0 }
        _ -> Just { path: init, off: last.item + 1 }

-- | The mirror of right.
left :: Box -> Pos -> Maybe Pos
left line p = do
  box <- containerAt line p.path
  case if p.off > 0 then A.index box (p.off - 1) else Nothing of
    Just it | hasSlots it -> do
      let k = A.length (slotsOf it) - 1
      s <- A.index (slotsOf it) k
      Just { path: A.snoc p.path { item: p.off - 1, slot: k }, off: A.length s }
    Just _ -> Just p { off = p.off - 1 }
    Nothing -> do
      { init, last } <- A.unsnoc p.path
      outer <- containerAt line init
      it <- A.index outer last.item
      if last.slot > 0 then do
        s <- A.index (slotsOf it) (last.slot - 1)
        Just { path: A.snoc init last { slot = last.slot - 1 }, off: A.length s }
      else case partner outer last.item of
        Just j | isScript it && j == last.item - 1 -> do
          other <- A.index outer j
          s <- A.index (slotsOf other) 0
          Just { path: A.snoc init { item: j, slot: 0 }, off: A.length s }
        _ -> Just { path: init, off: last.item }

-- ---------------------------------------------------------------------------
-- Option + Left / Right: term by term

-- | Operators split a container into terms: + - * = < > , ; relation and
-- | binary symbols, and a structure putting a label over or under one
-- | (N \overset{f}{\to} M has the terms N and M).
isOperator :: Item -> Boolean
isOperator it = case kind it of
  "ch" -> elem (nameOf it) [ "+", "-", "*", "=", "<", ">", ",", ";" ]
  "sym" -> let Item i = it in i.cls == "rel" || i.cls == "bin"
  "struct"
    | nameOf it == "overset" || nameOf it == "underset" -> case A.index (slotsOf it) 1 of
        Just [ base ] -> isOperator base
        _ -> false
  _ -> false

-- A label over a lone arrow (N \overset{f}{\to} M) is an \overset like any
-- other here: rows to move between, an arrow to retype. That it is drawn
-- stretched to its label, and written out as \xrightarrow{f}, is the
-- editor's drawing and LaTeX, not a different structure.

-- | Each press crosses one run of operators or one term (a structure counts
-- | as part of the term it sits in). Parentheses make a scope: inside a
-- | group the steps stay between its "(" and ")", and from its inner edge
-- | the next press steps out past the parenthesis; from outside, a whole
-- | group is part of the term it sits in, h(m_2) being one term. At a
-- | container's edge, step out as the plain arrow does. In text, a formula is
-- | a single term; elsewhere in text the browser's own word steps apply
-- | (Nothing: not specified here).
termRight :: Box -> Pos -> Maybe Pos
termRight line p
  | not (inFormula p) = do
      it <- A.index line p.off
      if kind it == "math" then Just p { off = p.off + 1 } else Nothing
  | otherwise = do
      box <- containerAt line p.path
      let { group, hi } = scope box p.off
      if p.off >= hi then case group of
        Just g -> Just p { off = g.close + 1 }
        Nothing -> right line p
      else Just p { off = runEnd box hi p.off (unitIsOp box p.off) }
  where
  runEnd box hi i op =
    let next = unitEnd box i
    in if next < hi && unitIsOp box next == op then runEnd box hi next op else next

termLeft :: Box -> Pos -> Maybe Pos
termLeft line p
  | not (inFormula p) = do
      it <- if p.off > 0 then A.index line (p.off - 1) else Nothing
      if kind it == "math" then Just p { off = p.off - 1 } else Nothing
  | otherwise = do
      box <- containerAt line p.path
      let { group, lo } = scope box p.off
      if p.off <= lo then case group of
        Just g -> Just p { off = g.open }
        Nothing -> left line p
      else
        let first = unitStart box p.off
        in Just p { off = runStart box lo first (unitIsOp box first) }
  where
  runStart box lo i op =
    let prev = unitStart box i
    in if i > lo && unitIsOp box prev == op then runStart box lo prev op else i

-- | Matching parentheses in a container.
type Group = { open :: Int, close :: Int }

groups :: Box -> Array Group
groups box = go 0 [] []
  where
  go i stack acc = case A.index box i of
    Nothing -> acc
    Just it
      | it == ch '(' -> go (i + 1) (A.cons i stack) acc
      | it == ch ')' -> case A.uncons stack of
          Just { head: o, tail } -> go (i + 1) tail (A.snoc acc { open: o, close: i })
          Nothing -> go (i + 1) stack acc
      | otherwise -> go (i + 1) stack acc

-- | Where option steps from off may go: inside the innermost group around
-- | it, or the whole container.
scope :: Box -> Int -> { group :: Maybe Group, lo :: Int, hi :: Int }
scope box off = case A.last (A.sortWith _.open (A.filter (\g -> g.open < off && off <= g.close) (groups box))) of
  Just g -> { group: Just g, lo: g.open + 1, hi: g.close }
  Nothing -> { group: Nothing, lo: 0, hi: A.length box }

-- | What the steps cross: a whole group, or one item.
unitEnd :: Box -> Int -> Int
unitEnd box i = maybe (i + 1) (\g -> g.close + 1) (A.find (\g -> g.open == i) (groups box))

unitStart :: Box -> Int -> Int
unitStart box i = maybe (i - 1) _.open (A.find (\g -> g.close == i - 1) (groups box))

unitIsOp :: Box -> Int -> Boolean
unitIsOp box i
  | isJust (A.find (\g -> g.open == i) (groups box)) = false
  | otherwise = maybe false isOperator (A.index box i)

-- ---------------------------------------------------------------------------
-- Selection shape

-- | Every selection is put in this shape, however it was made: a selection
-- | begun in a formula goes no further than the formula's edge; both ends in
-- | one container (an end inside a formula or a structure grows to take in
-- | the whole of it); and a caret never between a pair of scripts (it goes
-- | before the pair).
shape :: Box -> Sel -> Sel
shape line s0 =
  let
    s = { anchor: s0.anchor, head: clampToFormula line s0.anchor s0.head }
    common = commonSteps s.anchor.path s.head.path
    lift p isFirst = case A.index p.path common of
      Just step -> { path: A.take common p.path, off: if isFirst then step.item else step.item + 1 }
      Nothing -> p
  in
    if s.anchor == s.head then let c = shapeCaret line s.head in { anchor: c, head: c }
    else { anchor: lift s.anchor (before s.anchor s.head), head: lift s.head (before s.head s.anchor) }

-- | The head, kept within the formula the anchor is in.
clampToFormula :: Box -> Pos -> Pos -> Pos
clampToFormula line anchor head = case A.head anchor.path of
  Nothing -> head
  Just top
    | A.head head.path == Just top -> head
    | otherwise ->
        let edge = { path: [ top ], off: if before head anchor then 0 else A.length (fromMaybe [] (containerAt line [ top ])) }
        in edge

shapeCaret :: Box -> Pos -> Pos
shapeCaret line p = case containerAt line p.path of
  Just box | betweenPair box p.off -> p { off = p.off - 1 }
  _ -> p

commonSteps :: Array Step -> Array Step -> Int
commonSteps a b = go 0
  where
  go d = case A.index a d, A.index b d of
    Just x, Just y | x == y -> go (d + 1)
    _, _ -> d

-- | Shift + Left / Right: the head takes a plain step (over a structure as a
-- | whole, the shape takes care of that), Shift + Cmd: to the formula's edge;
-- | either way no further than the formula. Nothing when the anchor is not in
-- | a formula (the browser selects).
selectStep :: Int -> Box -> Sel -> Maybe Sel
selectStep dir line s
  | not (inFormula s.anchor) = Nothing
  | otherwise = do
      head <- (if dir > 0 then right else left) line s.head
      Just (shape line { anchor: s.anchor, head })

selectEdge :: Int -> Box -> Sel -> Maybe Sel
selectEdge dir line s = do
  top <- A.head s.anchor.path
  formula <- containerAt line [ top ]
  Just (shape line { anchor: s.anchor, head: { path: [ top ], off: if dir > 0 then A.length formula else 0 } })

-- | Option + Shift: the head takes a term step, the anchor stays, and the
-- | selection keeps its shape and never leaves the formula. Nothing when the
-- | anchor is not in a formula (then the browser selects words).
selectTerm :: Int -> Box -> Sel -> Maybe Sel
selectTerm dir line s
  | not (inFormula s.anchor) || not (inFormula s.head) = Nothing
  | otherwise = do
      let top = { item: (fromMaybe { item: 0, slot: 0 } (A.head s.anchor.path)).item, slot: 0 }
      formula <- containerAt line [ top ]
      let edge = if dir > 0 then { path: [ top ], off: A.length formula } else { path: [ top ], off: 0 }
      moved <- (if dir > 0 then termRight else termLeft) line s.head
      let head = if inFormula moved then moved else edge
      Just (shape line { anchor: s.anchor, head })

-- ---------------------------------------------------------------------------
-- Rewrites of a selection

-- | A rewrite offered for the items from..to of the container at path: what
-- | replaces them. The hint under a selection shows only the notation
-- | changes (slash, frac, power); "\" offers them all.
type Rewrite = { id :: String, replace :: Box }

rewrites :: Box -> Array Step -> Int -> Int -> Array Rewrite
rewrites line path from to = case containerAt line path of
  Nothing -> []
  Just _ | not (inFormula { path, off: 0 }) || to <= from || inText line path -> []
  Just box ->
    let
      xs = A.slice from to box
      one = case xs of
        [ it ] | kind it /= "ch" -> Just it
        _ -> Nothing
      slash = case one of
        -- a/b only when both sides' parentheses pair up: otherwise the ones
        -- added around a side could not be told apart on the way back
        Just it | kind it == "struct" && (nameOf it == "frac" || nameOf it == "dfrac") && balanced (slot 0 it) && balanced (slot 1 it) ->
          [ { id: "slash", replace: paren (slot 0 it) <> [ ch '/' ] <> paren (slot 1 it) } ]
        _ -> []
      frac = case slashAt xs of
        Just i -> [ { id: "frac", replace: [ struct "frac" [ unparen (A.take i xs), unparen (A.drop (i + 1) xs) ] ] } ]
        Nothing -> []
      power = case one of
        Just it | kind it == "struct" && nameOf it == "sqrt" ->
          [ { id: "power", replace: paren (slot 0 it) <> [ sup [ struct "frac" [ chars "1", chars "2" ] ] ] } ]
        _ -> []
      scripts = case one of
        Just it | isScript it -> [ { id: "unscript", replace: slot 0 it } ]
        _ -> [ { id: "sup", replace: [ sup xs ] }, { id: "sub", replace: [ sub xs ] } ]
    in
      slash <> frac <> power <> scripts
  where
  slot k it = fromMaybe [] (A.index (slotsOf it) k)

-- | \text{…} and kin hold plain text: nothing is rewritten in them.
inText :: Box -> Array Step -> Boolean
inText line path = fromMaybe false do
  { init, last } <- A.unsnoc path
  box <- containerAt line init
  it <- A.index box last.item
  pure (kind it == "struct" && elem (nameOf it) [ "text", "textrm", "textbf", "textit", "textsf", "texttt" ])

-- | Replace from..to of the container at path.
replaceIn :: Box -> Array Step -> Int -> Int -> Box -> Box
replaceIn box path from to with = case A.uncons path of
  Nothing -> A.take from box <> with <> A.drop to box
  Just { head: s, tail } -> fromMaybe box do
    Item it <- A.index box s.item
    inner <- A.index it.slots s.slot
    slots <- A.updateAt s.slot (replaceIn inner tail from to with) it.slots
    A.updateAt s.item (Item it { slots = slots }) box

-- | One token (a letter, a number, a symbol or a structure) stands beside
-- | "/" or under a power as it is; anything longer gets parentheses.
atomic :: Box -> Boolean
atomic xs = case xs of
  [] -> true
  [ it ] | kind it /= "ch" -> true
  _ | all (\it -> kind it == "ch") xs ->
        let s = foldMap nameOf xs
        in (A.length xs == 1 && isLetter s) || all (\it -> isDigitOrDot (nameOf it)) xs
  _ -> false
  where
  isLetter s = s >= "A" && s <= "Z" || s >= "a" && s <= "z"
  isDigitOrDot s = s == "." || s >= "0" && s <= "9"

paren :: Box -> Box
paren xs = if atomic xs then xs else [ ch '(' ] <> xs <> [ ch ')' ]

-- | (a+b) -> a+b, when the outer parentheses enclose all of it.
unparen :: Box -> Box
unparen xs =
  if A.length xs >= 2 && A.head xs == Just (ch '(') && A.last xs == Just (ch ')') && not (closesEarly 0 0) then A.slice 1 (A.length xs - 1) xs
  else xs
  where
  closesEarly i depth = case A.index xs i of
    Nothing -> false
    Just it
      | it == ch '(' -> closesEarly (i + 1) (depth + 1)
      | it == ch ')' -> (depth == 1 && i < A.length xs - 1) || closesEarly (i + 1) (depth - 1)
      | otherwise -> closesEarly (i + 1) depth

-- | Every ")" closes a "(" before it, and every "(" is closed.
balanced :: Box -> Boolean
balanced xs = go 0 0
  where
  go i depth = case A.index xs i of
    Nothing -> depth == 0
    Just it
      | it == ch '(' -> go (i + 1) (depth + 1)
      | it == ch ')' -> depth > 0 && go (i + 1) (depth - 1)
      | otherwise -> go (i + 1) depth

-- | The first "/" outside parentheses.
slashAt :: Box -> Maybe Int
slashAt xs = go 0 0
  where
  go i depth = case A.index xs i of
    Nothing -> Nothing
    Just it
      | it == ch '(' -> go (i + 1) (depth + 1)
      | it == ch ')' -> go (i + 1) (depth - 1)
      | it == ch '/' && depth == 0 -> Just i
      | otherwise -> go (i + 1) depth

hasRewrite :: String -> Array Rewrite -> Boolean
hasRewrite id = isJust <<< A.find (\r -> r.id == id)
