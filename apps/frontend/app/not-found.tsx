import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center text-zinc-100">
      <div className="text-center px-6">
        <p className="text-6xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-500 mb-4">
          404
        </p>
        <h1 className="text-2xl font-bold mb-2">Page Not Found</h1>
        <p className="text-zinc-400 mb-8 max-w-md">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-full transition-colors"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
