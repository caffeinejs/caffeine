import type { ReactNode } from 'react'

interface Props {
  sidebar: ReactNode
  navbar: ReactNode
  children: ReactNode
}

export function Layout({ sidebar, navbar, children }: Props) {
  return (
    <div className="flex h-full overflow-hidden bg-white text-zinc-900 antialiased dark:bg-[#1e1e20] dark:text-zinc-100">
      {sidebar}
      <div className="flex flex-1 flex-col overflow-hidden">
        {navbar}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
