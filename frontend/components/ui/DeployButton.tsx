import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cloud, CloudUpload } from 'lucide-react';

interface DeployButtonProps {
  onClick: (e: React.MouseEvent) => void;
  deploying: boolean;
  disabled?: boolean;
  className?: string;
  text?: string;
}

export function DeployButton({ onClick, deploying, disabled, className, text = "Deploy App" }: DeployButtonProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <motion.button
      onClick={onClick}
      disabled={deploying || disabled}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.96 }}
      className={`relative flex items-center justify-center text-black h-[32px] px-3 rounded-md text-sm font-medium bg-white border border-white cursor-pointer transition-colors duration-150 ${className || ''}`}
    >
      <div className="relative w-[16px] h-[16px] flex items-center justify-center shrink-0">
        <AnimatePresence mode="popLayout" initial={false}>
          {!deploying && !isHovered ? (
            <motion.div
              key="cloud"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ type: "spring", stiffness: 600, damping: 25 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <Cloud className="w-4 h-4 text-black" />
            </motion.div>
          ) : (
            <motion.div
              key="upload"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ type: "spring", stiffness: 600, damping: 25 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <CloudUpload className="w-4 h-4 text-black" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <span className="font-medium tracking-tight text-[13px] ml-2.5 text-black">
        {deploying ? "Deploying..." : text}
      </span>
    </motion.button>
  );
}
