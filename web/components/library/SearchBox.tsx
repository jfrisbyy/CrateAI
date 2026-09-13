"use client";

import { useEffect, useState } from "react";
import { useSearch } from "@/components/shell/searchState";
import { cx, input } from "@/components/ui";

export function SearchBox() {
  const search = useSearch();
  const [text, setText] = useState("");

  useEffect(() => {
    if (!search.active) setText("");
  }, [search.active]);

  return (
    <form
      role="search"
      className="flex items-center gap-2 w-full max-w-[520px]"
      onSubmit={(e) => {
        e.preventDefault();
        void search.run(text);
      }}
    >
      <label htmlFor="library-search" className="sr-only">
        Search the library
      </label>
      <input
        id="library-search"
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setText("");
            search.clear();
          }
        }}
        placeholder='Search: "85 bpm", "80-95", "f minor", "fm", "kind:stem"'
        className={cx(input, "w-full")}
        autoComplete="off"
        spellCheck={false}
      />
      {search.active && (
        <button type="button" onClick={search.clear} className="text-xs text-chalk-dim hover:text-chalk whitespace-nowrap">
          Clear
        </button>
      )}
    </form>
  );
}
