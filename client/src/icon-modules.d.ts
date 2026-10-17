// 图标包的 ESM 子路径没有附带声明，复用它提供的同一组件类型，保持严格类型检查。
declare module '@ant-design/icons/es/icons/*' {
  import type { AntdIconProps } from '@ant-design/icons/lib/components/AntdIcon';
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  const Icon: ForwardRefExoticComponent<AntdIconProps & RefAttributes<HTMLSpanElement>>;
  export default Icon;
}
